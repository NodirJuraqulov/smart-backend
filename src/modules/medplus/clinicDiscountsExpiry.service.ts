import { db } from "@/config/db";
import { getOrgTodayRange } from "./medplus.service";

export async function runClinicDiscountsExpiry(): Promise<number> {
  const organizations = await db("tb_organizations").select("id", "timezone").where({ is_active: true });
  let expiredCount = 0;
  for (const organization of organizations) {
    const { start } = getOrgTodayRange(organization.timezone);
    expiredCount += await db("tb_clinic_discounts")
      .where({ org_id: organization.id, status: "pending" })
      .andWhere("created_at", "<", start)
      .update({ status: "expired" });
  }
  console.log(`Klinika chegirmalari muddati tekshirildi: ${expiredCount} ta yozuv eskirdi`);
  return expiredCount;
}
