import cron from "node-cron";
import { runClinicDiscountsExpiry } from "@/modules/medplus/clinicDiscountsExpiry.service";

export { runClinicDiscountsExpiry };

const EXPIRY_SCHEDULE = "10 0 * * *";

export function scheduleClinicDiscountsExpiryJob(): void {
  cron.schedule(EXPIRY_SCHEDULE, async () => {
    try {
      await runClinicDiscountsExpiry();
    } catch (err) {
      console.error("Klinika chegirmalari muddatini tekshirishda xato:", err);
    }
  });
}
