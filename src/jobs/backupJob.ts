import cron from "node-cron";
import { runBackup } from "@/scripts/backup";

const BACKUP_SCHEDULE = "0 3 * * *";

export function scheduleBackupJob(): void {
  cron.schedule(BACKUP_SCHEDULE, async () => {
    try {
      const filepath = await runBackup();
      console.log(`Rejalashtirilgan backup muvaffaqiyatli yaratildi: ${filepath}`);
    } catch (err) {
      console.error("Rejalashtirilgan backup xatosi:", err);
    }
  });

  console.log(`Backup job rejalashtirildi (cron: "${BACKUP_SCHEDULE}")`);
}
