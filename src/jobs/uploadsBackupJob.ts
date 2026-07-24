import cron from "node-cron";
import { runUploadsBackup } from "@/scripts/backupUploads";

const UPLOADS_BACKUP_SCHEDULE = "15 3 * * *";

export function scheduleUploadsBackupJob(): void {
  cron.schedule(UPLOADS_BACKUP_SCHEDULE, async () => {
    try {
      const filepath = await runUploadsBackup();
      if (filepath) {
        console.log(`Rejalashtirilgan rasm backup muvaffaqiyatli yaratildi: ${filepath}`);
      }
    } catch (err) {
      console.error("Rejalashtirilgan rasm backup xatosi:", err);
    }
  });

  console.log(`Rasm backup job rejalashtirildi (cron: "${UPLOADS_BACKUP_SCHEDULE}")`);
}
