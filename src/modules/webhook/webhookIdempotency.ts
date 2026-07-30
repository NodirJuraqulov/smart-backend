import { db } from "@/config/db";

type Direction = "entry" | "exit";

const DEDUPE_WINDOW_SECONDS = 10;
const DEFAULT_CROSS_CAMERA_GUARD_SECONDS = 90;

export type WebhookEventRegistration =
  | { status: "accepted"; eventId: number }
  | { status: "same_direction_duplicate"; eventId: number }
  | {
      status: "opposite_camera_echo";
      eventId: number;
      firstDirection: Direction;
      deltaSeconds: number;
    };

export interface WebhookEventMetadata {
  confidence?: number | null;
  deviceId?: string | null;
  cameraEventAt?: Date | null;
}

export async function registerWebhookEvent(
  orgId: number,
  plateNumber: string,
  direction: Direction,
  metadata: WebhookEventMetadata = {}
): Promise<WebhookEventRegistration> {
  return db.transaction(async (trx) => {
    const organization = await trx("tb_organizations")
      .select("gate_layout", "cross_camera_guard_seconds")
      .where({ id: orgId })
      .forUpdate()
      .first();

    const sameDirection = await trx("tb_webhook_events")
      .where({ org_id: orgId, plate_number: plateNumber, direction })
      .andWhere("created_at", ">=", trx.raw(`NOW() - INTERVAL ${DEDUPE_WINDOW_SECONDS} SECOND`))
      .andWhere((builder) => {
        builder
          .whereNull("processing_result")
          .orWhereNotIn("processing_result", ["duplicate_same_direction", "opposite_camera_echo"]);
      })
      .first();
    if (sameDirection) {
      const [eventId] = await trx("tb_webhook_events").insert({
        org_id: orgId,
        plate_number: plateNumber,
        direction,
        confidence: metadata.confidence ?? null,
        device_id: metadata.deviceId ?? null,
        camera_event_at: metadata.cameraEventAt ?? null,
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
    if (organization?.gate_layout === "shared") {
      const oppositeDirection: Direction = direction === "entry" ? "exit" : "entry";
      const opposite = await trx("tb_webhook_events")
        .select("direction", "processed_at")
        .where({
          org_id: orgId,
          plate_number: plateNumber,
          direction: oppositeDirection,
        })
        .whereNotNull("processed_at")
        .andWhere("processed_at", "<=", trx.fn.now())
        .andWhere("processed_at", ">=", trx.raw(`NOW() - INTERVAL ${guardSeconds} SECOND`))
        .orderBy("processed_at", "desc")
        .first();

      if (opposite?.processed_at) {
        const deltaSeconds = Math.max(
          0,
          Math.floor((Date.now() - new Date(opposite.processed_at).getTime()) / 1000)
        );
        const [eventId] = await trx("tb_webhook_events").insert({
          org_id: orgId,
          plate_number: plateNumber,
          direction,
          confidence: metadata.confidence ?? null,
          device_id: metadata.deviceId ?? null,
          camera_event_at: metadata.cameraEventAt ?? null,
          processing_result: "opposite_camera_echo",
          processing_reason: "cross_camera_guard",
        });
        return {
          status: "opposite_camera_echo" as const,
          eventId,
          firstDirection: opposite.direction as Direction,
          deltaSeconds,
        };
      }
    }

    const [eventId] = await trx("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: plateNumber,
      direction,
      confidence: metadata.confidence ?? null,
      device_id: metadata.deviceId ?? null,
      camera_event_at: metadata.cameraEventAt ?? null,
    });
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
