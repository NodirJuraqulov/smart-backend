import cron from "node-cron";
import { runInpatientVehiclesExpiry } from "@/modules/medplus/inpatientVehiclesExpiry.service";

export { runInpatientVehiclesExpiry };

const EXPIRY_SCHEDULE = "15 0 * * *";

export function scheduleInpatientVehiclesExpiryJob(): void {
  cron.schedule(EXPIRY_SCHEDULE, async () => {
    try {
      await runInpatientVehiclesExpiry();
    } catch (err) {
      console.error("Statsionar mashinalar muddatini tekshirishda xato:", err);
    }
  });
}
