import cron from "node-cron";
import { runExitCandidatesExpiry } from "@/modules/exitCandidates/exitCandidatesExpiry.service";

export { runExitCandidatesExpiry };

export function scheduleExitCandidatesExpiryJob(): void {
  cron.schedule("* * * * *", async () => {
    try {
      await runExitCandidatesExpiry();
    } catch (err) {
      console.error("Exit candidate muddatini tekshirishda xato:", err);
    }
  });
}
