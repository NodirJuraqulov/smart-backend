import type { Knex } from "knex";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { logActivity } from "@/utils/activityLog";
import { resolveOrgIdRequired } from "@/utils/orgScope";

export interface CashCollectionRow {
  id: number;
  org_id: number;
  collected_by: number | null;
  expected_amount: string;
  collected_amount: string;
  online_amount_snapshot: string;
  note: string | null;
  period_start: Date;
  period_end: Date;
  created_at: Date;
}

export interface CashCollectionListRow extends CashCollectionRow {
  collected_by_name: string | null;
}

interface PendingSummary {
  expected_cash_amount: number;
  online_amount: number;
  period_start: Date;
  period_end: Date;
}

function safeAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export async function findLastCollectionPeriodEnd(
  orgId: number,
  executor: Knex = db
): Promise<Date | null> {
  const last = await executor<CashCollectionRow>("tb_cash_collections")
    .select("period_end")
    .where({ org_id: orgId })
    .orderBy("period_end", "desc")
    .orderBy("id", "desc")
    .first();
  return last ? new Date(last.period_end) : null;
}

export async function resolveCurrentPeriodStart(orgId: number, executor: Knex = db): Promise<Date> {
  const lastPeriodEnd = await findLastCollectionPeriodEnd(orgId, executor);
  if (lastPeriodEnd) return lastPeriodEnd;

  const organization = await executor("tb_organizations").select("created_at").where({ id: orgId }).first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
  return new Date(organization.created_at);
}

async function sumPaymentsByMethod(
  orgId: number,
  periodStart: Date,
  periodEnd: Date,
  executor: Knex = db
): Promise<{ cash: number; online: number }> {
  const rows = await executor("tb_payments")
    .where({ org_id: orgId })
    .andWhere("paid_at", ">=", periodStart)
    .andWhere("paid_at", "<", periodEnd)
    .groupBy("payment_method")
    .select("payment_method")
    .sum<{ payment_method: string; total: string | null }[]>("amount as total");

  let cash = 0;
  let online = 0;
  for (const row of rows) {
    if (row.payment_method === "online") online += safeAmount(row.total);
    else if (row.payment_method === "cash") cash += safeAmount(row.total);
  }
  return { cash, online };
}

async function buildPendingSummary(
  orgId: number,
  periodEnd: Date,
  executor: Knex = db
): Promise<PendingSummary> {
  const periodStart = await resolveCurrentPeriodStart(orgId, executor);
  const totals = await sumPaymentsByMethod(orgId, periodStart, periodEnd, executor);
  return {
    expected_cash_amount: totals.cash,
    online_amount: totals.online,
    period_start: periodStart,
    period_end: periodEnd,
  };
}

export async function getUncollectedRevenue(orgId: number, executor: Knex = db): Promise<number> {
  const periodStart = await resolveCurrentPeriodStart(orgId, executor);
  const totals = await sumPaymentsByMethod(orgId, periodStart, new Date(), executor);
  return totals.cash + totals.online;
}

export async function getPendingSummary(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined
): Promise<PendingSummary> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  return buildPendingSummary(orgId, new Date());
}

export async function createCashCollection(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { collectedAmount: unknown; note?: unknown }
): Promise<CashCollectionRow> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);

  const collectedAmount = Number(input.collectedAmount);
  if (
    input.collectedAmount === undefined ||
    input.collectedAmount === null ||
    input.collectedAmount === "" ||
    !Number.isFinite(collectedAmount) ||
    collectedAmount < 0
  ) {
    throw new ApiError("collected_amount manfiy bo'lmagan son bo'lishi kerak", 400);
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;

  const collection = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const periodEnd = new Date();
    const summary = await buildPendingSummary(orgId, periodEnd, trx);

    const [id] = await trx("tb_cash_collections").insert({
      org_id: orgId,
      collected_by: actor.id,
      expected_amount: summary.expected_cash_amount,
      collected_amount: collectedAmount,
      online_amount_snapshot: summary.online_amount,
      note,
      period_start: summary.period_start,
      period_end: periodEnd,
    });

    const created = await trx<CashCollectionRow>("tb_cash_collections").where({ id }).first();
    if (!created) throw new ApiError("Inkassatsiya yozuvi yaratilmadi", 500);
    return created;
  });

  await logActivity(actor.id, "cash_collection.created", "cash_collection", collection.id, {
    orgId,
    expectedAmount: Number(collection.expected_amount),
    collectedAmount: Number(collection.collected_amount),
    onlineAmountSnapshot: Number(collection.online_amount_snapshot),
    periodStart: new Date(collection.period_start).toISOString(),
    periodEnd: new Date(collection.period_end).toISOString(),
  });

  return collection;
}

export async function listCashCollections(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);

  const [{ count }] = await db("tb_cash_collections")
    .where({ org_id: orgId })
    .count<{ count: string }[]>("id as count");

  const collections = await db<CashCollectionListRow>("tb_cash_collections")
    .leftJoin("tb_users", "tb_users.id", "tb_cash_collections.collected_by")
    .where({ "tb_cash_collections.org_id": orgId })
    .select("tb_cash_collections.*", "tb_users.name as collected_by_name")
    .orderBy("tb_cash_collections.period_end", "desc")
    .orderBy("tb_cash_collections.id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);

  const total = Number(count);
  return {
    collections,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      total_pages: Math.ceil(total / input.limit) || 1,
    },
  };
}
