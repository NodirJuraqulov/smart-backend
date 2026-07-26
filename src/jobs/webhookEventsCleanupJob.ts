import cron from "node-cron";
import { db } from "@/config/db";

const RETENTION_HOURS = 24;

export async function runWebhookEventsCleanup(): Promise<void> {
  const deletedCount = await db("tb_webhook_events")
    .where("created_at", "<", db.raw(`NOW() - INTERVAL ${RETENTION_HOURS} HOUR`))
    .del();

  console.log(`Webhook hodisalari tozalandi: ${deletedCount} ta eski yozuv o'chirildi`);
}

const CLEANUP_SCHEDULE = "0 5 * * *";

export function scheduleWebhookEventsCleanupJob(): void {
  cron.schedule(CLEANUP_SCHEDULE, async () => {
    try {
      await runWebhookEventsCleanup();
    } catch (err) {
      console.error("Webhook hodisalarini tozalashda xato:", err);
    }
  });

  console.log(`Webhook hodisalarini tozalash job rejalashtirildi (cron: "${CLEANUP_SCHEDULE}")`);
}

if (require.main === module) {
  runWebhookEventsCleanup()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Tozalash xatosi:", err);
      process.exit(1);
    });
}
