import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";

interface TariffIntervalRecord {
  id: number;
  org_id: number;
  from_minutes: number;
  to_minutes: number | null;
  price: string;
  created_at: Date;
}

interface TariffIntervalInput {
  from_minutes: number;
  to_minutes?: number | null;
  price: number;
}

interface UpdateTariffIntervalInput {
  from_minutes?: number;
  to_minutes?: number | null;
  price?: number;
}

function assertValidRange(fromMinutes: number, toMinutes: number | null) {
  if (!Number.isInteger(fromMinutes) || fromMinutes < 0) {
    throw new ApiError("from_minutes butun va manfiy bo'lmagan son bo'lishi kerak", 400);
  }
  if (toMinutes !== null && (!Number.isInteger(toMinutes) || toMinutes <= fromMinutes)) {
    throw new ApiError("to_minutes from_minutes dan katta bo'lishi kerak", 400);
  }
}

function intervalsOverlap(
  aFrom: number,
  aTo: number | null,
  bFrom: number,
  bTo: number | null
): boolean {
  const aEnd = aTo ?? Infinity;
  const bEnd = bTo ?? Infinity;
  return aFrom <= bEnd && bFrom <= aEnd;
}

async function assertNoOverlap(
  orgId: number,
  fromMinutes: number,
  toMinutes: number | null,
  excludeId?: number
) {
  const query = db<TariffIntervalRecord>("tb_tariff_intervals").where({ org_id: orgId });
  if (excludeId !== undefined) {
    query.andWhereNot({ id: excludeId });
  }
  const existingIntervals = await query;

  const hasOverlap = existingIntervals.some((interval) =>
    intervalsOverlap(fromMinutes, toMinutes, interval.from_minutes, interval.to_minutes)
  );

  if (hasOverlap) {
    throw new ApiError("Interval boshqa interval bilan ustma-ust tushadi", 400);
  }
}

async function findTariffIntervalOrFail(orgId: number, id: number) {
  const interval = await db<TariffIntervalRecord>("tb_tariff_intervals")
    .where({ id, org_id: orgId })
    .first();
  if (!interval) {
    throw new ApiError("Interval topilmadi", 404);
  }
  return interval;
}

export async function listTariffIntervals(orgId: number) {
  await assertOrganizationExists(orgId);
  return db<TariffIntervalRecord>("tb_tariff_intervals")
    .where({ org_id: orgId })
    .orderBy("from_minutes", "asc");
}

export async function createTariffInterval(orgId: number, input: TariffIntervalInput) {
  await assertOrganizationExists(orgId);

  const toMinutes = input.to_minutes ?? null;
  assertValidRange(input.from_minutes, toMinutes);
  await assertNoOverlap(orgId, input.from_minutes, toMinutes);

  const [id] = await db("tb_tariff_intervals").insert({
    org_id: orgId,
    from_minutes: input.from_minutes,
    to_minutes: toMinutes,
    price: input.price,
  });

  return db<TariffIntervalRecord>("tb_tariff_intervals").where({ id }).first();
}

export async function updateTariffInterval(
  orgId: number,
  id: number,
  input: UpdateTariffIntervalInput
) {
  const interval = await findTariffIntervalOrFail(orgId, id);

  const fromMinutes = input.from_minutes ?? interval.from_minutes;
  const toMinutes = input.to_minutes !== undefined ? input.to_minutes : interval.to_minutes;
  assertValidRange(fromMinutes, toMinutes);
  await assertNoOverlap(orgId, fromMinutes, toMinutes, id);

  const updates: Record<string, unknown> = { from_minutes: fromMinutes, to_minutes: toMinutes };
  if (input.price !== undefined) updates.price = input.price;

  await db("tb_tariff_intervals").where({ id }).update(updates);

  return db<TariffIntervalRecord>("tb_tariff_intervals").where({ id }).first();
}

export async function deleteTariffInterval(orgId: number, id: number) {
  await findTariffIntervalOrFail(orgId, id);
  await db("tb_tariff_intervals").where({ id }).del();
}
