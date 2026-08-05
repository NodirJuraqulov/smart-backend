import { db } from "@/config/db";
import { getOrgTodayDate } from "./medplus.service";

export async function runInpatientVehiclesExpiry(): Promise<number> {
  const organizations = await db("tb_organizations").select("id", "timezone").where({ is_active: true });
  let expiredCount = 0;
  for (const organization of organizations) {
    const today = getOrgTodayDate(organization.timezone);
    expiredCount += await db("tb_inpatient_vehicles")
      .where({ org_id: organization.id, status: "active" })
      .andWhere("valid_until", "<", today)
      .update({ status: "expired" });
  }
  console.log(`Statsionar mashinalar muddati tekshirildi: ${expiredCount} ta yozuv eskirdi`);
  return expiredCount;
}
