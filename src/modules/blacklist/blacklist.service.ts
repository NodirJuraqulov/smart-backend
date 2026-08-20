import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { resolveSafeCameraEventTime } from "@/modules/webhook/webhookIdempotency";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdRequired } from "@/utils/orgScope";

export interface BlacklistedVehicleRow {
  id: number;
  org_id: number;
  plate_number: string;
  reason: string | null;
  created_by: number | null;
  created_at: Date;
}

export interface BlacklistAttemptRow {
  id: number;
  org_id: number;
  plate_number: string;
  attempted_at: Date;
  image_url: string | null;
  direction: "entry";
}

export type BlacklistAttemptMatchResult =
  | { matched: false }
  | { matched: true; created: boolean; attempt: BlacklistAttemptRow };

interface WebhookEventImageRow {
  id: number;
  org_id: number;
  direction: "entry" | "exit";
  camera_event_at: Date | string | null;
  created_at: Date | string;
  overview_image_path: string | null;
  vehicle_image_path: string | null;
  plate_image_path: string | null;
}

const BLACKLIST_ATTEMPT_DEDUPE_WINDOW_MS = 30_000;

function normalizePlate(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const reason = value.trim();
  if (reason.length > 500) throw new ApiError("reason 500 belgidan oshmasligi kerak", 400);
  return reason || null;
}

function pagination(input: { page: number; limit: number }, total: number) {
  return {
    page: input.page,
    limit: input.limit,
    total,
    total_pages: Math.ceil(total / input.limit) || 1,
  };
}

function imageUrl(
  eventId: number,
  event: Pick<WebhookEventImageRow, "overview_image_path" | "vehicle_image_path" | "plate_image_path">
): string | null {
  if (event.overview_image_path) return `/api/webhook-events/${eventId}/images/overview`;
  if (event.vehicle_image_path) return `/api/webhook-events/${eventId}/images/vehicle`;
  if (event.plate_image_path) return `/api/webhook-events/${eventId}/images/plate`;
  return null;
}

export async function listBlacklistedVehicles(actor: AuthTokenPayload, requestedOrgId: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  return db<BlacklistedVehicleRow>("tb_blacklisted_vehicles")
    .where({ org_id: orgId })
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
}

export async function createBlacklistedVehicle(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  input: { plateNumber: string; reason?: string | null }
): Promise<BlacklistedVehicleRow> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const plateNumber = normalizePlate(input.plateNumber);
  if (!plateNumber || plateNumber.length > 20) throw new ApiError("plate_number noto'g'ri", 400);
  const reason = normalizeReason(input.reason);

  let id: number;
  try {
    [id] = await db("tb_blacklisted_vehicles").insert({
      org_id: orgId,
      plate_number: plateNumber,
      reason,
      created_by: actor.id,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError("Bu nomer allaqachon qora ro'yxatda", 409);
    }
    throw error;
  }

  const vehicle = await db<BlacklistedVehicleRow>("tb_blacklisted_vehicles")
    .where({ id, org_id: orgId })
    .first();
  if (!vehicle) throw new ApiError("Qora ro'yxat yozuvi yaratilmadi", 500);
  return vehicle;
}

export async function deleteBlacklistedVehicle(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  blacklistId: number
): Promise<void> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const deleted = await db("tb_blacklisted_vehicles").where({ id: blacklistId, org_id: orgId }).del();
  if (deleted === 0) throw new ApiError("Qora ro'yxat yozuvi topilmadi", 404);
}

export async function listBlacklistAttempts(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  input: { page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const query = db<BlacklistAttemptRow>("tb_blacklist_attempts").where({ org_id: orgId });
  const [{ count }] = await query.clone().count<{ count: string }[]>("id as count");
  const attempts = await query
    .clone()
    .orderBy("attempted_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  return { attempts, pagination: pagination(input, Number(count)) };
}

export async function recordBlacklistAttemptIfMatched(input: {
  orgId: number;
  webhookEventId: number;
  plateNumber: string;
}): Promise<BlacklistAttemptMatchResult> {
  const plateNumber = normalizePlate(input.plateNumber);
  if (!plateNumber) return { matched: false };

  return db.transaction(async (trx) => {
    const blacklisted = await trx<BlacklistedVehicleRow>("tb_blacklisted_vehicles")
      .select("id")
      .where({ org_id: input.orgId, plate_number: plateNumber })
      .forUpdate()
      .first();
    if (!blacklisted) return { matched: false };

    const event = await trx<WebhookEventImageRow>("tb_webhook_events")
      .select(
        "camera_event_at",
        "created_at",
        "overview_image_path",
        "vehicle_image_path",
        "plate_image_path"
      )
      .where({ id: input.webhookEventId, org_id: input.orgId, direction: "entry" })
      .first();
    if (!event) throw new ApiError("Webhook kirish hodisasi topilmadi", 404);

    const attemptedAt = resolveSafeCameraEventTime(event.camera_event_at, event.created_at);
    const recentAttempt = await trx<BlacklistAttemptRow>("tb_blacklist_attempts")
      .where({ org_id: input.orgId, plate_number: plateNumber, direction: "entry" })
      .andWhere("attempted_at", ">=", new Date(attemptedAt.getTime() - BLACKLIST_ATTEMPT_DEDUPE_WINDOW_MS))
      .andWhere("attempted_at", "<=", attemptedAt)
      .orderBy("attempted_at", "desc")
      .orderBy("id", "desc")
      .forUpdate()
      .first();
    await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
      processing_result: "entry_blacklisted",
      processing_reason: "blacklist_match",
      processed_at: trx.fn.now(),
    });
    if (recentAttempt) {
      return { matched: true, created: false, attempt: recentAttempt };
    }

    const [attemptId] = await trx("tb_blacklist_attempts").insert({
      org_id: input.orgId,
      plate_number: plateNumber,
      attempted_at: attemptedAt,
      image_url: imageUrl(input.webhookEventId, event),
      direction: "entry",
    });
    const attempt = await trx<BlacklistAttemptRow>("tb_blacklist_attempts")
      .where({ id: attemptId, org_id: input.orgId })
      .first();
    if (!attempt) throw new ApiError("Qora ro'yxat urinishi yozilmadi", 500);
    return { matched: true, created: true, attempt };
  });
}
