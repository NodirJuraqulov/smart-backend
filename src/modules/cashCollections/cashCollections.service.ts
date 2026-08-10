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
  operator_id: number | null;
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
  operator_id_name: string | null;
}

interface PendingSummary {
  operator_id: number;
  expected_cash_amount: number;
  online_amount: number;
  period_start: Date;
  period_end: Date;
}

function safeAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function latestDate(dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

async function findLegacyOrgPeriodEnd(orgId: number, executor: Knex): Promise<Date | null> {
  const legacy = await executor("tb_cash_collections")
    .select("period_end")
    .where({ org_id: orgId })
    .whereNull("operator_id")
    .orderBy("period_end", "desc")
    .orderBy("id", "desc")
    .first();
  return legacy ? new Date(legacy.period_end) : null;
}

export async function assertOperatorInOrganization(
  orgId: number,
  operatorId: number,
  executor: Knex = db
): Promise<{ id: number; created_at: Date }> {
  const operator = await executor("tb_users")
    .select("id", "created_at")
    .where({ id: operatorId, org_id: orgId, role: "operator" })
    .first();
  if (!operator) throw new ApiError("Operator topilmadi", 404);
  return operator;
}

async function resolveOperatorPeriodStart(
  orgId: number,
  operatorId: number,
  executor: Knex
): Promise<Date> {
  const operator = await assertOperatorInOrganization(orgId, operatorId, executor);

  const personal = await executor("tb_cash_collections")
    .select("period_end")
    .where({ org_id: orgId, operator_id: operatorId })
    .orderBy("period_end", "desc")
    .orderBy("id", "desc")
    .first();

  const legacyPeriodEnd = await findLegacyOrgPeriodEnd(orgId, executor);

  const boundaries = [new Date(operator.created_at)];
  if (personal) boundaries.push(new Date(personal.period_end));
  if (legacyPeriodEnd) boundaries.push(legacyPeriodEnd);
  return latestDate(boundaries);
}

async function sumOperatorPaymentsByMethod(
  orgId: number,
  operatorId: number,
  periodStart: Date,
  periodEnd: Date,
  executor: Knex
): Promise<{ cash: number; online: number }> {
  const rows = await executor("tb_payments")
    .where({ org_id: orgId, operator_id: operatorId })
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
  operatorId: number,
  periodEnd: Date,
  executor: Knex
): Promise<PendingSummary> {
  const periodStart = await resolveOperatorPeriodStart(orgId, operatorId, executor);
  const totals = await sumOperatorPaymentsByMethod(orgId, operatorId, periodStart, periodEnd, executor);
  return {
    operator_id: operatorId,
    expected_cash_amount: totals.cash,
    online_amount: totals.online,
    period_start: periodStart,
    period_end: periodEnd,
  };
}

export async function getOrgUncollectedRevenue(orgId: number, executor: Knex = db): Promise<number> {
  const organization = await executor("tb_organizations").select("created_at").where({ id: orgId }).first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);

  const legacyPeriodEnd = await findLegacyOrgPeriodEnd(orgId, executor);
  const baseline = legacyPeriodEnd ?? new Date(organization.created_at);

  const [{ total }] = await executor("tb_payments as p")
    .leftJoin(
      executor("tb_cash_collections")
        .select("operator_id")
        .max("period_end as last_end")
        .where({ org_id: orgId })
        .whereNotNull("operator_id")
        .groupBy("operator_id")
        .as("c"),
      "c.operator_id",
      "p.operator_id"
    )
    .where({ "p.org_id": orgId })
    .andWhere("p.paid_at", ">=", baseline)
    .andWhere((builder) => {
      builder.whereNull("c.last_end").orWhere("p.paid_at", ">=", executor.ref("c.last_end"));
    })
    .sum<{ total: string | null }[]>("p.amount as total");

  return safeAmount(total);
}

export async function listOrganizationOperators(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);

  return db("tb_users")
    .select("id", "name")
    .where({ org_id: orgId, role: "operator" })
    .orderBy("name", "asc");
}

export async function getPendingSummary(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  operatorId: number
): Promise<PendingSummary> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  return buildPendingSummary(orgId, operatorId, new Date(), db);
}

export async function createCashCollection(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { operatorId: number; collectedAmount: unknown; note?: unknown }
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
    const summary = await buildPendingSummary(orgId, input.operatorId, periodEnd, trx);

    const [id] = await trx("tb_cash_collections").insert({
      org_id: orgId,
      operator_id: input.operatorId,
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
    operatorId: input.operatorId,
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
    .leftJoin("tb_users as collector", "collector.id", "tb_cash_collections.collected_by")
    .leftJoin("tb_users as shift_operator", "shift_operator.id", "tb_cash_collections.operator_id")
    .where({ "tb_cash_collections.org_id": orgId })
    .select(
      "tb_cash_collections.*",
      "collector.name as collected_by_name",
      "shift_operator.name as operator_id_name"
    )
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
