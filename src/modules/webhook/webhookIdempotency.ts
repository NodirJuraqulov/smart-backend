import { db } from "@/config/db";

type Direction = "entry" | "exit";

const DEDUPE_WINDOW_SECONDS = 10;
const DEFAULT_CROSS_CAMERA_GUARD_SECONDS = 90;
const MAX_CAMERA_CLOCK_SKEW_SECONDS = 300;
const SUPPRESSED_RESULTS = [
  "duplicate_same_direction",
  "opposite_camera_echo",
  "shared_lane_conflict",
] as const;

export type WebhookEventRegistration =
  | { status: "accepted"; eventId: number }
  | { status: "same_direction_duplicate"; eventId: number }
  | {
      status: "opposite_camera_echo";
      eventId: number;
      firstDirection: Direction;
      deltaSeconds: number;
    }
  | {
      status: "shared_lane_conflict";
      eventId: number;
      firstDirection: Direction;
      firstPlateNumber: string;
      deltaSeconds: number;
    };

export interface WebhookEventMetadata {
  confidence?: number | null;
  deviceId?: string | null;
  cameraEventAt?: Date | null;
}

interface WebhookEventTimeRow {
  id: number;
  org_id?: number;
  plate_number: string | null;
  direction: Direction;
  camera_event_at: Date | string | null;
  created_at: Date | string;
  processing_result: string | null;
}

function asValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function effectiveEventTime(row: WebhookEventTimeRow): Date {
  const createdAt = asValidDate(row.created_at) ?? new Date();
  const cameraEventAt = asValidDate(row.camera_event_at);
  if (!cameraEventAt) return createdAt;
  const skewSeconds = Math.abs(cameraEventAt.getTime() - createdAt.getTime()) / 1000;
  return skewSeconds <= MAX_CAMERA_CLOCK_SKEW_SECONDS ? cameraEventAt : createdAt;
}

function calculateDeltaSeconds(
  previous: WebhookEventTimeRow,
  current: WebhookEventTimeRow
): number | null {
  let deltaMs = effectiveEventTime(current).getTime() - effectiveEventTime(previous).getTime();
  if (deltaMs < 0) {
    const previousCreatedAt = asValidDate(previous.created_at);
    const currentCreatedAt = asValidDate(current.created_at);
    if (!previousCreatedAt || !currentCreatedAt) return null;
    deltaMs = currentCreatedAt.getTime() - previousCreatedAt.getTime();
  }
  if (deltaMs < 0 || !Number.isFinite(deltaMs)) return null;
  return Math.round((deltaMs / 1000) * 1000) / 1000;
}

function isPlausiblePlate(value: string): boolean {
  return value.length >= 5 && value.length <= 20 && /^[A-Z0-9]+$/.test(value);
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) differences += 1;
  return differences === 1;
}

function hasMissingLeadingCharacters(left: string, right: string): boolean {
  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  const missingCount = longer.length - shorter.length;
  return (missingCount === 1 || missingCount === 2) && longer.endsWith(shorter);
}

function isNearPlateMatch(left: string, right: string): boolean {
  if (!isPlausiblePlate(left) || !isPlausiblePlate(right) || left === right) return false;
  return editDistanceAtMostOne(left, right) || hasMissingLeadingCharacters(left, right);
}

export async function registerWebhookEvent(
  orgId: number,
  plateNumber: string | null,
  direction: Direction,
  metadata: WebhookEventMetadata = {}
): Promise<WebhookEventRegistration> {
  return db.transaction(async (trx) => {
    const cameraEventAt = asValidDate(metadata.cameraEventAt);
    const organization = await trx("tb_organizations")
      .select("gate_layout", "cross_camera_guard_seconds")
      .where({ id: orgId })
      .forUpdate()
      .first();

    const [eventId] = await trx("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: plateNumber,
      direction,
      confidence: metadata.confidence ?? null,
      device_id: metadata.deviceId ?? null,
      camera_event_at: cameraEventAt,
    });
    const currentEvent = await trx<WebhookEventTimeRow>("tb_webhook_events")
      .select(
        "id",
        "plate_number",
        "direction",
        "camera_event_at",
        "created_at",
        "processing_result"
      )
      .where({ id: eventId })
      .first();
    if (!currentEvent) throw new Error(`Webhook audit event #${eventId} topilmadi`);

    const sameDirection = plateNumber
      ? await trx("tb_webhook_events")
          .where({ org_id: orgId, plate_number: plateNumber, direction })
          .whereNot({ id: eventId })
          .andWhere("created_at", ">=", trx.raw(`NOW() - INTERVAL ${DEDUPE_WINDOW_SECONDS} SECOND`))
          .andWhere((builder) => {
            builder
              .whereNull("processing_result")
              .orWhereNotIn("processing_result", [...SUPPRESSED_RESULTS]);
          })
          .orderBy("created_at", "desc")
          .first()
      : null;
    if (sameDirection) {
      await trx("tb_webhook_events").where({ id: eventId }).update({
        processing_result: "duplicate_same_direction",
        processing_reason: "dedupe_window",
      });
      return { status: "same_direction_duplicate" as const, eventId };
    }

    const configuredGuard = Number(organization?.cross_camera_guard_seconds);
    const guardSeconds =
      Number.isInteger(configuredGuard) && configuredGuard >= 5 && configuredGuard <= 300
        ? configuredGuard
        : DEFAULT_CROSS_CAMERA_GUARD_SECONDS;
    if (organization?.gate_layout === "shared" && plateNumber) {
      const oppositeDirection: Direction = direction === "entry" ? "exit" : "entry";
      const candidateWindowSeconds = guardSeconds + MAX_CAMERA_CLOCK_SKEW_SECONDS * 2;
      const oppositeEvents = await trx<WebhookEventTimeRow>("tb_webhook_events")
        .select(
          "id",
          "plate_number",
          "direction",
          "camera_event_at",
          "created_at",
          "processing_result"
        )
        .where({
          org_id: orgId,
          direction: oppositeDirection,
        })
        .whereNot({ id: eventId })
        .andWhere("created_at", ">=", trx.raw(`NOW() - INTERVAL ${candidateWindowSeconds} SECOND`))
        .andWhere((builder) => {
          builder
            .whereNull("processing_result")
            .orWhereNotIn("processing_result", [...SUPPRESSED_RESULTS]);
        })
        .orderBy("created_at", "desc");

      const recentOppositeEvents = oppositeEvents
        .map((opposite) => ({
          opposite,
          deltaSeconds: calculateDeltaSeconds(opposite, currentEvent),
        }))
        .filter(
          (
            candidate
          ): candidate is { opposite: WebhookEventTimeRow; deltaSeconds: number } =>
            candidate.deltaSeconds !== null && candidate.deltaSeconds <= guardSeconds
        );
      const exactMatch = recentOppositeEvents.find(
        ({ opposite }) => opposite.plate_number === plateNumber
      );
      if (exactMatch) {
        await trx("tb_webhook_events").where({ id: eventId }).update({
          processing_result: "opposite_camera_echo",
          processing_reason: "cross_camera_guard",
        });
        return {
          status: "opposite_camera_echo" as const,
          eventId,
          firstDirection: exactMatch.opposite.direction,
          deltaSeconds: exactMatch.deltaSeconds,
        };
      }

      const nearMatch = recentOppositeEvents.find(
        ({ opposite }) =>
          opposite.plate_number !== null && isNearPlateMatch(opposite.plate_number, plateNumber)
      );
      if (nearMatch) {
        await trx("tb_webhook_events").where({ id: eventId }).update({
          processing_result: "shared_lane_conflict",
          processing_reason: "near_plate_cross_camera_guard",
        });
        return {
          status: "shared_lane_conflict" as const,
          eventId,
          firstDirection: nearMatch.opposite.direction,
          firstPlateNumber: nearMatch.opposite.plate_number!,
          deltaSeconds: nearMatch.deltaSeconds,
        };
      }
    }

    return { status: "accepted" as const, eventId };
  });
}

export async function markWebhookEventProcessed(eventId: number): Promise<void> {
  await db("tb_webhook_events")
    .where({ id: eventId })
    .whereNull("processed_at")
    .update({ processed_at: db.fn.now() });
}

export async function updateWebhookEventOutcome(
  eventId: number,
  outcome: {
    processingResult: string;
    processingReason?: string | null;
    sessionId?: number | null;
    processed?: boolean;
  }
): Promise<void> {
  await db("tb_webhook_events")
    .where({ id: eventId })
    .update({
      processing_result: outcome.processingResult,
      processing_reason: outcome.processingReason ?? null,
      session_id: outcome.sessionId ?? null,
      ...(outcome.processed ? { processed_at: db.fn.now() } : {}),
    });
}

export async function recordWebhookAuditEvent(input: {
  orgId: number;
  direction: Direction;
  processingResult: string;
  processingReason?: string | null;
  plateNumber?: string | null;
  confidence?: number | null;
  deviceId?: string | null;
  cameraEventAt?: Date | null;
}): Promise<number> {
  const [eventId] = await db("tb_webhook_events").insert({
    org_id: input.orgId,
    plate_number: input.plateNumber ?? null,
    direction: input.direction,
    confidence: input.confidence ?? null,
    device_id: input.deviceId ?? null,
    camera_event_at: input.cameraEventAt ?? null,
    processing_result: input.processingResult,
    processing_reason: input.processingReason ?? null,
  });
  return eventId;
}

export async function isDuplicateWebhookEvent(
  orgId: number,
  plateNumber: string,
  direction: Direction
): Promise<boolean> {
  const registration = await registerWebhookEvent(orgId, plateNumber, direction);
  return registration.status === "same_direction_duplicate";
}

export async function clearWebhookDedupeCache(): Promise<void> {
  await db("tb_webhook_events").del();
}
