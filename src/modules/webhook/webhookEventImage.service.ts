import { promises as fs } from "fs";
import path from "path";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { NormalizedCameraEvent } from "./parsers/normalizedCameraEvent";
import { ApiError } from "@/utils/ApiError";

export type WebhookEventImageKind = "overview" | "vehicle" | "plate";

const EVENT_UPLOAD_ROOT = path.resolve(process.cwd(), "uploads", "parking-events");

function detectImage(buffer: Buffer): { extension: "jpg" | "png"; contentType: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  return null;
}

function safeFileName(value: string | null | undefined): string | null {
  if (!value) return null;
  return path.basename(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150) || null;
}

async function writeAtomic(filePath: string, buffer: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
  try {
    await fs.link(temporaryPath, filePath);
    await fs.unlink(temporaryPath);
  } catch (err) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw err;
  }
}

async function saveOne(
  directory: string,
  relativeParts: string[],
  kind: WebhookEventImageKind,
  buffer: Buffer | null | undefined
): Promise<string | null> {
  if (!buffer?.length) return null;
  const imageType = detectImage(buffer);
  if (!imageType) return null;
  const fileName = `${kind}.${imageType.extension}`;
  const absolutePath = path.resolve(directory, fileName);
  if (!absolutePath.startsWith(`${directory}${path.sep}`)) {
    throw new Error("Webhook event rasmi event katalogidan tashqariga chiqdi");
  }
  await writeAtomic(absolutePath, buffer);
  return path.posix.join("uploads", "parking-events", ...relativeParts, fileName);
}

export async function saveWebhookEventImages(input: {
  orgId: number;
  eventId: number;
  direction: "entry" | "exit";
  event: NormalizedCameraEvent;
}): Promise<void> {
  const now = new Date();
  const relativeParts = [
    String(input.orgId),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(input.eventId),
  ];
  const directory = path.resolve(EVENT_UPLOAD_ROOT, ...relativeParts);
  if (!directory.startsWith(`${EVENT_UPLOAD_ROOT}${path.sep}`)) {
    throw new Error("Webhook event rasmi uploads/parking-events tashqarisiga chiqdi");
  }

  const inputs = [
    ["overview", input.event.overviewImage, input.event.overviewImageFileName],
    ["vehicle", input.event.vehicleImage, input.event.vehicleImageFileName],
    ["plate", input.event.plateImage, input.event.plateImageFileName],
  ] as const;
  const presentInputs = inputs.filter(([, buffer]) => !!buffer?.length);
  if (presentInputs.length === 0) {
    await db("tb_webhook_events").where({ id: input.eventId, org_id: input.orgId }).update({
      image_processing_result: "no_images",
      image_processing_reason: "camera_images_missing_or_invalid",
    });
    return;
  }

  await fs.mkdir(directory, { recursive: true });
  const results = await Promise.allSettled(
    inputs.map(([kind, buffer]) => saveOne(directory, relativeParts, kind, buffer))
  );
  const paths = {
    overview_image_path: results[0].status === "fulfilled" ? results[0].value : null,
    vehicle_image_path: results[1].status === "fulfilled" ? results[1].value : null,
    plate_image_path: results[2].status === "fulfilled" ? results[2].value : null,
  };
  const savedCount = Object.values(paths).filter(Boolean).length;
  const result = savedCount === presentInputs.length ? "saved" : savedCount > 0 ? "partial" : "failed";
  await db("tb_webhook_events").where({ id: input.eventId, org_id: input.orgId }).update({
    ...paths,
    image_processing_result: result,
    image_processing_reason: result === "saved" ? null : "invalid_or_write_failed",
  });

  console.log(
    `Webhook event images: org_id=${input.orgId} event_id=${input.eventId} direction=${input.direction} ` +
      `present=${presentInputs.map(([kind]) => kind).join(",")} ` +
      `bytes=${presentInputs.map(([kind, buffer]) => `${kind}:${buffer!.length}`).join(",")} ` +
      `files=${presentInputs.map(([kind, , fileName]) => `${kind}:${safeFileName(fileName) ?? "none"}`).join(",")} ` +
      `vehicle_source=${String(input.event.metadata?.vehicleImageSource ?? "unknown")} result=${result}`
  );
}

export async function markDuplicateImagesSkipped(orgId: number, eventId: number): Promise<void> {
  await db("tb_webhook_events").where({ id: eventId, org_id: orgId }).update({
    image_processing_result: "skipped",
    image_processing_reason: "duplicate_skipped",
  });
}

function resolveEventImagePath(relativePath: string, orgId: number, eventId: number): string | null {
  const expectedPrefix = path.posix.join(
    "uploads",
    "parking-events",
    String(orgId)
  ) + "/";
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith(expectedPrefix) || normalized.includes("..")) return null;
  const absolutePath = path.resolve(process.cwd(), normalized);
  if (!absolutePath.startsWith(`${EVENT_UPLOAD_ROOT}${path.sep}`)) return null;
  const segments = normalized.split("/");
  if (
    segments.length !== 8 ||
    segments[0] !== "uploads" ||
    segments[1] !== "parking-events" ||
    segments[2] !== String(orgId) ||
    segments[6] !== String(eventId)
  ) {
    return null;
  }
  return absolutePath;
}

export async function getWebhookEventImage(
  actor: AuthTokenPayload,
  eventId: number,
  kind: WebhookEventImageKind
): Promise<{ absolutePath: string; contentType: string }> {
  const column = `${kind}_image_path`;
  const event = await db("tb_webhook_events")
    .select("org_id", column)
    .where({ id: eventId })
    .first();
  if (!event || (actor.role !== "super_admin" && actor.org_id !== event.org_id)) {
    throw new ApiError("Rasm topilmadi", 404);
  }
  const relativePath = event[column] as string | null;
  if (!relativePath) throw new ApiError("Rasm topilmadi", 404);
  const absolutePath = resolveEventImagePath(relativePath, event.org_id, eventId);
  if (!absolutePath) throw new ApiError("Rasm topilmadi", 404);
  const buffer = await fs.readFile(absolutePath).catch(() => null);
  if (!buffer) throw new ApiError("Rasm topilmadi", 404);
  const imageType = detectImage(buffer);
  if (!imageType) throw new ApiError("Rasm topilmadi", 404);
  return { absolutePath, contentType: imageType.contentType };
}
