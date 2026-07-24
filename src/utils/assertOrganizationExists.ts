import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";

export async function assertOrganizationExists(orgId: number): Promise<void> {
  const organization = await db("tb_organizations").where({ id: orgId }).first();
  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
}
