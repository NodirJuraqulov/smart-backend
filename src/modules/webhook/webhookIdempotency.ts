import { db } from "@/config/db";

type Direction = "entry" | "exit";

const DEDUPE_WINDOW_SECONDS = 10;
const DEFAULT_CROSS_CAMERA_GUARD_SECONDS = 90;

export type WebhookEventRegistration =
  | { status: "accepted"; eventId: number }
  | { status: "same_direction_duplicate" }
  | {
      status: "opposite_camera_echo";
      firstDirection: Direction;
      deltaSeconds: number;
    };

export async function registerWebhookEvent(
  orgId: number,
  plateNumber: string,
  direction: Direction
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
      .first();
    if (sameDirection) return { status: "same_direction_duplicate" as const };

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
        return {
          status: "opposite_camera_echo" as const,
          firstDirection: opposite.direction as Direction,
          deltaSeconds,
        };
      }
    }

    const [eventId] = await trx("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: plateNumber,
      direction,
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
