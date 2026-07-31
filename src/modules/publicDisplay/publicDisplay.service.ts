import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { applyInsideSessionsFilter } from "@/modules/parking/sessionStatus";

export async function getDisplayStatus(orgId: number) {
  const organization = await db("tb_organizations")
    .select("name", "pricing_mode", "total_capacity")
    .where({ id: orgId })
    .first();

  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }

  const [{ count }] = await applyInsideSessionsFilter(
    db("tb_parking_sessions").where({ org_id: orgId })
  ).count<{ count: string }[]>("id as count");

  const occupied = Number(count);
  const total: number | null = organization.total_capacity ?? null;

  const status: Record<string, unknown> = {
    orgName: organization.name,
    pricingMode: organization.pricing_mode,
    capacity: {
      occupied,
      total,
      available: total === null ? null : Math.max(0, total - occupied),
    },
  };

  if (organization.pricing_mode === "interval") {
    const intervals = await db("tb_tariff_intervals")
      .select("from_minutes", "to_minutes", "price")
      .where({ org_id: orgId })
      .orderBy("from_minutes", "asc");

    status.intervalTariffs = intervals.map((interval) => ({
      fromMinutes: interval.from_minutes,
      toMinutes: interval.to_minutes,
      price: Number(interval.price),
    }));
  } else {
    const tariff = await db("tb_tariffs").select("price_per_hour", "grace_period_minutes").where({ org_id: orgId }).first();

    if (tariff) {
      status.hourlyTariff = {
        price: Number(tariff.price_per_hour),
        gracePeriodMinutes: tariff.grace_period_minutes,
      };
    }
  }

  return status;
}
