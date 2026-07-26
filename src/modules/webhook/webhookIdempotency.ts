import { db } from "@/config/db";

type Direction = "entry" | "exit";

const DEDUPE_WINDOW_SECONDS = 10;

export async function isDuplicateWebhookEvent(
  orgId: number,
  plateNumber: string,
  direction: Direction
): Promise<boolean> {
  return db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: orgId }).forUpdate().first();

    const existing = await trx("tb_webhook_events")
      .where({ org_id: orgId, plate_number: plateNumber, direction })
      .andWhere("created_at", ">=", trx.raw(`NOW() - INTERVAL ${DEDUPE_WINDOW_SECONDS} SECOND`))
      .first();

    if (existing) {
      return true;
    }

    await trx("tb_webhook_events").insert({ org_id: orgId, plate_number: plateNumber, direction });
    return false;
  });
}

export async function clearWebhookDedupeCache(): Promise<void> {
  await db("tb_webhook_events").del();
}
