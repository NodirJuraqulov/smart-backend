import { promises as fs } from "fs";
import path from "path";

export type ParkingImageDirection = "entry" | "exit";
export type ParkingImageKind = "vehicle" | "plate";

export interface ParkingImageInput {
  buffer?: Buffer | null;
  originalFileName?: string | null;
}

export interface ParkingImagePaths {
  vehiclePath: string | null;
  platePath: string | null;
}

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads", "parking");

function detectExtension(buffer: Buffer): "jpg" | "png" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  return null;
}

async function writeAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, bytes, { flag: "wx" });
  await fs.rename(temporaryPath, filePath);
}

async function saveOne(
  orgId: number,
  sessionId: number,
  direction: ParkingImageDirection,
  kind: ParkingImageKind,
  input: ParkingImageInput | undefined
): Promise<string | null> {
  const buffer = input?.buffer;
  if (!buffer?.length) return null;

  const extension = detectExtension(buffer);
  if (!extension) {
    console.warn(`ANPR rasm formati qo'llab-quvvatlanmaydi (org=${orgId}, session=${sessionId}, ${direction}_${kind})`);
    return null;
  }

  const now = new Date();
  const parts = [
    String(orgId),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(sessionId),
  ];
  const directory = path.resolve(UPLOAD_ROOT, ...parts);
  if (!directory.startsWith(`${UPLOAD_ROOT}${path.sep}`)) {
    throw new Error("Rasm saqlash yo'li uploads/parking tashqarisiga chiqdi");
  }

  await fs.mkdir(directory, { recursive: true });
  const fileName = `${direction}_${kind}.${extension}`;
  const absolutePath = path.join(directory, fileName);
  try {
    await fs.access(absolutePath);
    return path.posix.join("uploads", "parking", ...parts, fileName);
  } catch {
    await writeAtomic(absolutePath, buffer);
    return path.posix.join("uploads", "parking", ...parts, fileName);
  }
}

export async function saveParkingImages(
  orgId: number,
  sessionId: number,
  direction: ParkingImageDirection,
  vehicle: ParkingImageInput | undefined,
  plate: ParkingImageInput | undefined
): Promise<ParkingImagePaths> {
  const results = await Promise.allSettled([
    saveOne(orgId, sessionId, direction, "vehicle", vehicle),
    saveOne(orgId, sessionId, direction, "plate", plate),
  ]);

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.warn(
        `ANPR rasm saqlanmadi (org=${orgId}, session=${sessionId}, direction=${direction}, kind=${index === 0 ? "vehicle" : "plate"}):`,
        result.reason instanceof Error ? result.reason.message : result.reason
      );
    }
  }

  return {
    vehiclePath: results[0].status === "fulfilled" ? results[0].value : null,
    platePath: results[1].status === "fulfilled" ? results[1].value : null,
  };
}

export function resolveParkingImageAbsolutePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("uploads/parking/")) return null;
  const absolutePath = path.resolve(process.cwd(), normalized);
  return absolutePath.startsWith(`${UPLOAD_ROOT}${path.sep}`) ? absolutePath : null;
}
