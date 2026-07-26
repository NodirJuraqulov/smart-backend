import cron from "node-cron";
import { db } from "@/config/db";

const RETENTION_DAYS = 30;

export async function runWebhookDebugLogsCleanup(): Promise<void> {
  const deletedCount = await db("tb_webhook_debug_logs")
    .where("received_at", "<", db.raw(`NOW() - INTERVAL ${RETENTION_DAYS} DAY`))
    .del();

  console.log(`Webhook debug loglari tozalandi: ${deletedCount} ta eski yozuv o'chirildi`);
}

const CLEANUP_SCHEDULE = "15 5 * * *";

export function scheduleWebhookDebugLogsCleanupJob(): void {
  cron.schedule(CLEANUP_SCHEDULE, async () => {
    try {
      await runWebhookDebugLogsCleanup();
    } catch (err) {
      console.error("Webhook debug loglarini tozalashda xato:", err);
    }
  });

  console.log(`Webhook debug loglarini tozalash job rejalashtirildi (cron: "${CLEANUP_SCHEDULE}")`);
}

if (require.main === module) {
  runWebhookDebugLogsCleanup()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Tozalash xatosi:", err);
      process.exit(1);
    });
}
