import { DateTime } from "luxon";
import type { Knex } from "knex";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import { applyCompletedExitFilter, applyInsideSessionsFilter } from "@/modules/parking/sessionStatus";
import {
  getOperatorUncollectedRevenueByMethod,
  getOrgUncollectedRevenueByMethod,
} from "@/modules/cashCollections/cashCollections.service";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function getOrgTimezone(orgId: number): Promise<string> {
  const organization = await db("tb_organizations").select("timezone").where({ id: orgId }).first();
  return organization?.timezone ?? "Asia/Tashkent";
}

function isValidDateString(value: string, timezone: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dt = DateTime.fromISO(value, { zone: timezone });
  return dt.isValid && dt.toFormat("yyyy-MM-dd") === value;
}

function isFutureDate(value: string, timezone: string): boolean {
  const dt = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  const today = DateTime.now().setZone(timezone).startOf("day");
  return dt.toMillis() > today.toMillis();
}

function isFutureMonth(year: number, month: number, timezone: string): boolean {
  const now = DateTime.now().setZone(timezone);
  return year > now.year || (year === now.year && month > now.month);
}

function isFutureYear(year: number, timezone: string): boolean {
  return year > DateTime.now().setZone(timezone).year;
}

interface SessionTimeRow {
  org_id: number;
  status: "active" | "awaiting_payment" | "completed";
  entered_at: Date;
  exited_at: Date | null;
}

interface PaymentRow {
  org_id: number;
  paid_at: Date;
  amount: string;
  payment_method: "cash" | "online";
}

type PaymentLedgerRow = Pick<PaymentRow, "paid_at" | "amount" | "payment_method">;

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function timestampRange(column: string, start: Date, endExclusive: Date) {
  return db.raw("?? >= FROM_UNIXTIME(?) AND ?? < FROM_UNIXTIME(?)", [
    column,
    unixSeconds(start),
    column,
    unixSeconds(endExclusive),
  ]);
}

function applyOperatorFilter<T extends Knex.QueryBuilder>(query: T, operatorId?: number): T {
  if (operatorId !== undefined) {
    query.andWhere("operator_id", operatorId);
  }
  return query;
}

function paymentLedgerQuery(orgId: number, start: Date, endExclusive: Date, operatorId?: number) {
  return applyOperatorFilter(
    db<PaymentRow>("tb_payments")
      .where({ org_id: orgId })
      .where(timestampRange("paid_at", start, endExclusive))
      .select("paid_at", "amount", "payment_method"),
    operatorId
  );
}

function safeAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function splitRevenueByPaymentMethod(paymentsRows: PaymentLedgerRow[]): {
  cashRevenue: number;
  onlineRevenue: number;
} {
  let cashRevenue = 0;
  let onlineRevenue = 0;
  for (const row of paymentsRows) {
    if (row.payment_method === "online") {
      onlineRevenue += safeAmount(row.amount);
    } else if (row.payment_method === "cash") {
      cashRevenue += safeAmount(row.amount);
    }
  }
  return { cashRevenue, onlineRevenue };
}

async function getSubscriptionRevenue(
  orgId: number,
  createdStart: Date,
  createdEndExclusive: Date,
  renewedStartDate: string,
  renewedEndDate: string
): Promise<number> {
  const [{ total }] = await db("tb_subscriptions")
    .where({ org_id: orgId })
    .andWhere((builder) => {
      builder
        .where(timestampRange("created_at", createdStart, createdEndExclusive))
        .orWhereBetween("last_renewed_at", [renewedStartDate, renewedEndDate]);
    })
    .sum<{ total: string | null }[]>("price_snapshot as total");
  return safeAmount(total);
}

export async function getDailyReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  dateParam: string | undefined,
  operatorId?: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const timezone = await getOrgTimezone(orgId);

  const date = dateParam ?? DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");
  if (!isValidDateString(date, timezone)) {
    throw new ApiError("date formati noto'g'ri (YYYY-MM-DD)", 400);
  }
  if (isFutureDate(date, timezone)) {
    throw new ApiError("Kelajakdagi sana uchun hisobot bo'lishi mumkin emas", 400);
  }

  const dayAnchor = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  const dayStart = dayAnchor.toJSDate();
  const dayEndExclusive = dayAnchor.plus({ days: 1 }).toJSDate();

  const [entriesRows, exitsRows, paymentsRows, [{ count: currentlyParked }], subscriptionRevenue] =
    await Promise.all([
      db<SessionTimeRow>("tb_parking_sessions")
        .where({ org_id: orgId })
        .where(timestampRange("entered_at", dayStart, dayEndExclusive))
        .select("entered_at"),
      applyCompletedExitFilter(
        db<SessionTimeRow>("tb_parking_sessions").where({ org_id: orgId })
      )
        .where(timestampRange("exited_at", dayStart, dayEndExclusive))
        .select("exited_at"),
      paymentLedgerQuery(orgId, dayStart, dayEndExclusive, operatorId),
      applyInsideSessionsFilter(
        db("tb_parking_sessions").where({ org_id: orgId })
      )
        .count<{ count: string }[]>("id as count"),
      getSubscriptionRevenue(orgId, dayStart, dayEndExclusive, date, date),
    ]);

  const hourlyEntries = Array.from({ length: 24 }, () => 0);
  for (const row of entriesRows) {
    hourlyEntries[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).hour]++;
  }

  const hourlyRevenue = Array.from({ length: 24 }, () => 0);
  for (const row of paymentsRows) {
    hourlyRevenue[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).hour] += safeAmount(row.amount);
  }

  const hourlyBreakdown = hourlyEntries.map((entries, hour) => ({
    hour,
    entries,
    revenue: hourlyRevenue[hour],
  }));

  const ledgerRevenue = splitRevenueByPaymentMethod(paymentsRows);
  const pendingRevenue =
    dateParam === undefined && operatorId === undefined
      ? actor.role === "operator"
        ? await getOperatorUncollectedRevenueByMethod(orgId, actor.id)
        : await getOrgUncollectedRevenueByMethod(orgId)
      : null;
  const cashRevenue = pendingRevenue?.cash ?? ledgerRevenue.cashRevenue;
  const onlineRevenue = pendingRevenue?.online ?? ledgerRevenue.onlineRevenue;
  const regularRevenue = cashRevenue + onlineRevenue;

  let busiestHour: string | null = null;
  const maxEntries = Math.max(...hourlyEntries);
  if (maxEntries > 0) {
    const hour = hourlyEntries.indexOf(maxEntries);
    busiestHour = `${pad(hour)}:00-${pad((hour + 1) % 24)}:00`;
  }

  return {
    org_id: orgId,
    date,
    total_entries: entriesRows.length,
    total_exits: exitsRows.length,
    cash_revenue: cashRevenue,
    online_revenue: onlineRevenue,
    regular_revenue: regularRevenue,
    subscription_revenue: subscriptionRevenue,
    vip_revenue: 0,
    total_revenue: regularRevenue + subscriptionRevenue,
    currently_parked: Number(currentlyParked),
    busiest_hour: busiestHour,
    hourly_breakdown: hourlyBreakdown,
  };
}

export async function getMonthlyReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  yearParam: number | undefined,
  monthParam: number | undefined,
  operatorId?: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const timezone = await getOrgTimezone(orgId);

  const now = DateTime.now().setZone(timezone);
  const year = yearParam ?? now.year;
  const month = monthParam ?? now.month;

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError("year noto'g'ri", 400);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError("month noto'g'ri (1-12 oralig'ida bo'lishi kerak)", 400);
  }
  if (isFutureMonth(year, month, timezone)) {
    throw new ApiError("Kelajakdagi oy uchun hisobot bo'lishi mumkin emas", 400);
  }

  const monthAnchor = DateTime.fromObject({ year, month, day: 1 }, { zone: timezone });
  const monthStart = monthAnchor.startOf("month").toJSDate();
  const monthEndExclusive = monthAnchor.plus({ months: 1 }).startOf("month").toJSDate();
  const monthStartDate = monthAnchor.startOf("month").toFormat("yyyy-MM-dd");
  const monthEndDate = monthAnchor.endOf("month").toFormat("yyyy-MM-dd");
  const daysInMonth = monthAnchor.daysInMonth as number;

  const [entriesRows, exitsRows, paymentsRows, subscriptionRevenue] = await Promise.all([
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .where(timestampRange("entered_at", monthStart, monthEndExclusive))
      .select("entered_at"),
    applyCompletedExitFilter(
      db<SessionTimeRow>("tb_parking_sessions").where({ org_id: orgId })
    )
      .where(timestampRange("exited_at", monthStart, monthEndExclusive))
      .select("exited_at"),
    paymentLedgerQuery(orgId, monthStart, monthEndExclusive, operatorId),
    getSubscriptionRevenue(orgId, monthStart, monthEndExclusive, monthStartDate, monthEndDate),
  ]);

  const entriesByDay = Array.from({ length: daysInMonth + 1 }, () => 0);
  for (const row of entriesRows) {
    entriesByDay[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).day]++;
  }

  const exitsByDay = Array.from({ length: daysInMonth + 1 }, () => 0);
  for (const row of exitsRows) {
    exitsByDay[DateTime.fromJSDate(new Date(row.exited_at as Date)).setZone(timezone).day]++;
  }

  const revenueByDay = Array.from({ length: daysInMonth + 1 }, () => 0);
  for (const row of paymentsRows) {
    revenueByDay[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).day] += safeAmount(row.amount);
  }

  const dailyBreakdown = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dailyBreakdown.push({
      date: `${year}-${pad(month)}-${pad(day)}`,
      entries: entriesByDay[day],
      exits: exitsByDay[day],
      revenue: revenueByDay[day],
    });
  }

  const { cashRevenue, onlineRevenue } = splitRevenueByPaymentMethod(paymentsRows);
  const regularRevenue = cashRevenue + onlineRevenue;

  return {
    org_id: orgId,
    year,
    month,
    total_entries: entriesRows.length,
    total_exits: exitsRows.length,
    cash_revenue: cashRevenue,
    online_revenue: onlineRevenue,
    regular_revenue: regularRevenue,
    subscription_revenue: subscriptionRevenue,
    vip_revenue: 0,
    total_revenue: regularRevenue + subscriptionRevenue,
    daily_breakdown: dailyBreakdown,
  };
}

export async function getYearlyReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  yearParam: number | undefined,
  operatorId?: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const timezone = await getOrgTimezone(orgId);

  const year = yearParam ?? DateTime.now().setZone(timezone).year;

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError("year noto'g'ri", 400);
  }
  if (isFutureYear(year, timezone)) {
    throw new ApiError("Kelajakdagi yil uchun hisobot bo'lishi mumkin emas", 400);
  }

  const yearAnchor = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: timezone });
  const yearStart = yearAnchor.startOf("year").toJSDate();
  const yearEndExclusive = yearAnchor.plus({ years: 1 }).startOf("year").toJSDate();
  const yearStartDate = yearAnchor.startOf("year").toFormat("yyyy-MM-dd");
  const yearEndDate = yearAnchor.endOf("year").toFormat("yyyy-MM-dd");

  const [entriesRows, exitsRows, paymentsRows, subscriptionRevenue] = await Promise.all([
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .where(timestampRange("entered_at", yearStart, yearEndExclusive))
      .select("entered_at"),
    applyCompletedExitFilter(
      db<SessionTimeRow>("tb_parking_sessions").where({ org_id: orgId })
    )
      .where(timestampRange("exited_at", yearStart, yearEndExclusive))
      .select("exited_at"),
    paymentLedgerQuery(orgId, yearStart, yearEndExclusive, operatorId),
    getSubscriptionRevenue(orgId, yearStart, yearEndExclusive, yearStartDate, yearEndDate),
  ]);

  const entriesByMonth = Array.from({ length: 13 }, () => 0);
  for (const row of entriesRows) {
    entriesByMonth[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).month]++;
  }

  const exitsByMonth = Array.from({ length: 13 }, () => 0);
  for (const row of exitsRows) {
    exitsByMonth[DateTime.fromJSDate(new Date(row.exited_at as Date)).setZone(timezone).month]++;
  }

  const revenueByMonth = Array.from({ length: 13 }, () => 0);
  for (const row of paymentsRows) {
    revenueByMonth[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).month] += safeAmount(row.amount);
  }

  const monthlyBreakdown = [];
  for (let month = 1; month <= 12; month++) {
    monthlyBreakdown.push({
      month,
      entries: entriesByMonth[month],
      exits: exitsByMonth[month],
      revenue: revenueByMonth[month],
    });
  }

  const { cashRevenue, onlineRevenue } = splitRevenueByPaymentMethod(paymentsRows);
  const regularRevenue = cashRevenue + onlineRevenue;

  return {
    org_id: orgId,
    year,
    total_entries: entriesRows.length,
    total_exits: exitsRows.length,
    cash_revenue: cashRevenue,
    online_revenue: onlineRevenue,
    regular_revenue: regularRevenue,
    subscription_revenue: subscriptionRevenue,
    vip_revenue: 0,
    total_revenue: regularRevenue + subscriptionRevenue,
    monthly_breakdown: monthlyBreakdown,
  };
}

type RangeGranularity = "daily" | "monthly" | "yearly";

interface GroupedCountRow {
  bucket: string;
  count: string;
}

interface GroupedPaymentRow {
  bucket: string;
  payment_method: "cash" | "online";
  total: string | null;
}

interface SubscriptionRangeRow {
  org_id: number;
  created_at: Date;
  last_renewed_at: string | null;
  price_snapshot: string;
}

function requireCompleteRange(from: string | undefined, to: string | undefined, label: string): [string, string] {
  if (!from || !to) {
    throw new ApiError(`${label} uchun boshlanish va tugash qiymatlari birga yuborilishi kerak`, 400);
  }
  return [from, to];
}

interface RangeBucket {
  key: string;
  startUnix: number;
  endExclusiveUnix: number;
}

function nextBucketStart(value: DateTime, granularity: RangeGranularity): DateTime {
  if (granularity === "daily") return value.plus({ days: 1 });
  if (granularity === "monthly") return value.plus({ months: 1 });
  return value.plus({ years: 1 });
}

function buildBuckets(start: DateTime, end: DateTime, granularity: RangeGranularity): RangeBucket[] {
  const buckets: RangeBucket[] = [];
  let cursor = start;
  while (cursor.toMillis() <= end.toMillis()) {
    const next = nextBucketStart(cursor, granularity);
    buckets.push({
      key:
        granularity === "daily"
          ? cursor.toFormat("yyyy-MM-dd")
          : granularity === "monthly"
            ? cursor.toFormat("yyyy-MM")
            : cursor.toFormat("yyyy"),
      startUnix: unixSeconds(cursor.toJSDate()),
      endExclusiveUnix: unixSeconds(next.toJSDate()),
    });
    cursor = next;
  }
  return buckets;
}

function bucketExpression(column: string, buckets: RangeBucket[]) {
  const bindings: Knex.RawBinding[] = [];
  const clauses = buckets.map((bucket) => {
    bindings.push(column, bucket.startUnix, column, bucket.endExclusiveUnix, bucket.key);
    return "WHEN ?? >= FROM_UNIXTIME(?) AND ?? < FROM_UNIXTIME(?) THEN ?";
  });
  return db.raw(`CASE ${clauses.join(" ")} END as bucket`, bindings);
}

async function getRangeReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  granularity: RangeGranularity,
  start: DateTime,
  end: DateTime,
  operatorId?: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const timezone = await getOrgTimezone(orgId);
  const zonedStart = start.setZone(timezone, { keepLocalTime: true }).startOf(
    granularity === "daily" ? "day" : granularity === "monthly" ? "month" : "year"
  );
  const zonedEnd = end.setZone(timezone, { keepLocalTime: true }).endOf(
    granularity === "daily" ? "day" : granularity === "monthly" ? "month" : "year"
  );
  const buckets = buildBuckets(zonedStart, zonedEnd, granularity);
  const startDate = zonedStart.toJSDate();
  const endExclusive = new Date(buckets[buckets.length - 1].endExclusiveUnix * 1000);

  const [entries, exits, payments, subscriptions] = await Promise.all([
    db("tb_parking_sessions")
      .where({ org_id: orgId })
      .where(timestampRange("entered_at", startDate, endExclusive))
      .select(bucketExpression("entered_at", buckets))
      .count<GroupedCountRow[]>("id as count")
      .groupBy("bucket"),
    applyCompletedExitFilter(
      db("tb_parking_sessions").where({ org_id: orgId })
    )
      .where(timestampRange("exited_at", startDate, endExclusive))
      .select(bucketExpression("exited_at", buckets))
      .count<GroupedCountRow[]>("id as count")
      .groupBy("bucket"),
    applyOperatorFilter(
      db("tb_payments")
        .where("org_id", orgId)
        .where(timestampRange("paid_at", startDate, endExclusive)),
      operatorId
    )
      .select(bucketExpression("paid_at", buckets), "payment_method")
      .sum<GroupedPaymentRow[]>("amount as total")
      .groupBy("bucket", "payment_method"),
    db<SubscriptionRangeRow>("tb_subscriptions")
      .where({ org_id: orgId })
      .andWhere((builder) => {
        builder
          .where(timestampRange("created_at", startDate, endExclusive))
          .orWhereBetween("last_renewed_at", [
            zonedStart.toFormat("yyyy-MM-dd"),
            zonedEnd.toFormat("yyyy-MM-dd"),
          ]);
      })
      .select("created_at", "last_renewed_at", "price_snapshot"),
  ]);

  const entryMap = new Map(entries.map((row) => [row.bucket, Number(row.count)]));
  const exitMap = new Map(exits.map((row) => [row.bucket, Number(row.count)]));
  const cashMap = new Map<string, number>();
  const onlineMap = new Map<string, number>();
  for (const row of payments) {
    const map = row.payment_method === "online" ? onlineMap : cashMap;
    map.set(row.bucket, (map.get(row.bucket) ?? 0) + safeAmount(row.total));
  }

  const subscriptionMap = new Map<string, number>();
  for (const row of subscriptions) {
    const created = DateTime.fromJSDate(new Date(row.created_at)).setZone(timezone);
    const renewed = row.last_renewed_at
      ? DateTime.fromISO(row.last_renewed_at, { zone: timezone })
      : null;
    const occurrence =
      created.toMillis() >= zonedStart.toMillis() && created.toMillis() <= zonedEnd.toMillis()
        ? created
        : renewed;
    if (!occurrence) continue;
    const bucket =
      granularity === "daily"
        ? occurrence.toFormat("yyyy-MM-dd")
        : granularity === "monthly"
          ? occurrence.toFormat("yyyy-MM")
          : occurrence.toFormat("yyyy");
    subscriptionMap.set(bucket, (subscriptionMap.get(bucket) ?? 0) + safeAmount(row.price_snapshot));
  }

  const items = buckets.map(({ key: bucket }) => {
    const cashRevenue = cashMap.get(bucket) ?? 0;
    const onlineRevenue = onlineMap.get(bucket) ?? 0;
    const subscriptionRevenue = subscriptionMap.get(bucket) ?? 0;
    return {
      [granularity === "daily" ? "date" : granularity === "monthly" ? "month" : "year"]:
        granularity === "yearly" ? Number(bucket) : bucket,
      entries: entryMap.get(bucket) ?? 0,
      exits: exitMap.get(bucket) ?? 0,
      cash_revenue: cashRevenue,
      online_revenue: onlineRevenue,
      regular_revenue: cashRevenue + onlineRevenue,
      subscription_revenue: subscriptionRevenue,
      vip_revenue: 0,
      revenue: cashRevenue + onlineRevenue + subscriptionRevenue,
    };
  });

  const totals = items.reduce(
    (sum, item) => ({
      total_entries: sum.total_entries + item.entries,
      total_exits: sum.total_exits + item.exits,
      cash_revenue: sum.cash_revenue + item.cash_revenue,
      online_revenue: sum.online_revenue + item.online_revenue,
      regular_revenue: sum.regular_revenue + item.regular_revenue,
      subscription_revenue: sum.subscription_revenue + item.subscription_revenue,
      vip_revenue: 0,
      total_revenue: sum.total_revenue + item.revenue,
    }),
    {
      total_entries: 0,
      total_exits: 0,
      cash_revenue: 0,
      online_revenue: 0,
      regular_revenue: 0,
      subscription_revenue: 0,
      vip_revenue: 0,
      total_revenue: 0,
    }
  );

  return {
    org_id: orgId,
    ...totals,
    period: {
      type: granularity,
      from: items.length
        ? String(items[0][granularity === "daily" ? "date" : granularity === "monthly" ? "month" : "year"])
        : "",
      to: items.length
        ? String(items[items.length - 1][granularity === "daily" ? "date" : granularity === "monthly" ? "month" : "year"])
        : "",
    },
    totals,
    items,
  };
}

export async function getDailyRangeReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  operatorId?: number
) {
  const [from, to] = requireCompleteRange(fromParam, toParam, "Kunlik diapazon");
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const timezone = await getOrgTimezone(orgId);
  if (!isValidDateString(from, timezone) || !isValidDateString(to, timezone)) {
    throw new ApiError("from_date va to_date formati noto'g'ri (YYYY-MM-DD)", 400);
  }
  const start = DateTime.fromISO(from, { zone: timezone });
  const end = DateTime.fromISO(to, { zone: timezone });
  const days = Math.floor(end.startOf("day").diff(start.startOf("day"), "days").days) + 1;
  if (days < 1) throw new ApiError("from_date to_date dan keyin bo'lishi mumkin emas", 400);
  if (days > 366) throw new ApiError("Kunlik diapazon 366 kundan oshmasligi kerak", 400);
  if (isFutureDate(to, timezone)) throw new ApiError("Kelajakdagi sana uchun hisobot bo'lishi mumkin emas", 400);
  return getRangeReport(actor, requestedOrgId, "daily", start, end, operatorId);
}

export async function getMonthlyRangeReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  operatorId?: number
) {
  const [from, to] = requireCompleteRange(fromParam, toParam, "Oylik diapazon");
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    throw new ApiError("from_month va to_month formati noto'g'ri (YYYY-MM)", 400);
  }
  const start = DateTime.fromFormat(from, "yyyy-MM");
  const end = DateTime.fromFormat(to, "yyyy-MM");
  if (!start.isValid || !end.isValid || start.toFormat("yyyy-MM") !== from || end.toFormat("yyyy-MM") !== to) {
    throw new ApiError("from_month yoki to_month noto'g'ri", 400);
  }
  const months = Math.floor(end.startOf("month").diff(start.startOf("month"), "months").months) + 1;
  if (months < 1) throw new ApiError("from_month to_month dan keyin bo'lishi mumkin emas", 400);
  if (months > 120) throw new ApiError("Oylik diapazon 120 oydan oshmasligi kerak", 400);
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const timezone = await getOrgTimezone(orgId);
  if (isFutureMonth(end.year, end.month, timezone)) {
    throw new ApiError("Kelajakdagi oy uchun hisobot bo'lishi mumkin emas", 400);
  }
  return getRangeReport(actor, requestedOrgId, "monthly", start, end, operatorId);
}

export async function getYearlyRangeReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  operatorId?: number
) {
  const [from, to] = requireCompleteRange(fromParam, toParam, "Yillik diapazon");
  if (!/^\d{4}$/.test(from) || !/^\d{4}$/.test(to)) {
    throw new ApiError("from_year va to_year to'rt xonali yil bo'lishi kerak", 400);
  }
  const fromYear = Number(from);
  const toYear = Number(to);
  if (fromYear < 2000 || toYear > 2100) throw new ApiError("Yil 2000-2100 oralig'ida bo'lishi kerak", 400);
  if (fromYear > toYear) throw new ApiError("from_year to_year dan keyin bo'lishi mumkin emas", 400);
  if (toYear - fromYear + 1 > 20) throw new ApiError("Yillik diapazon 20 yildan oshmasligi kerak", 400);
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const timezone = await getOrgTimezone(orgId);
  if (isFutureYear(toYear, timezone)) throw new ApiError("Kelajakdagi yil uchun hisobot bo'lishi mumkin emas", 400);
  return getRangeReport(
    actor,
    requestedOrgId,
    "yearly",
    DateTime.fromObject({ year: fromYear, month: 1, day: 1 }),
    DateTime.fromObject({ year: toYear, month: 1, day: 1 }),
    operatorId
  );
}
