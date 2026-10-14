import cron from "node-cron";
import { env } from "@/config/env";
import { runStaleSessionsCleanup } from "@/modules/maintenance/staleSessionsCleanup.service";

export function scheduleStaleSessionsCleanupJob(): void {
  if (!env.staleSessionCleanup.enabled) return;
  cron.schedule(env.staleSessionCleanup.cron, async () => {
    try {
      await runStaleSessionsCleanup();
    } catch (error) {
      console.error("STALE_SESSION_CLEANUP_FAILED", error);
    }
  });
}
