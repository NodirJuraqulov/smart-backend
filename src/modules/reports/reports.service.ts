import { DateTime } from "luxon";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdRequired } from "@/utils/orgScope";

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
  status: "active" | "completed";
  entered_at: Date;
  exited_at: Date | null;
}

interface PaymentRow {
  org_id: number;
  paid_at: Date;
  amount: string;
  payment_method: "cash" | "online";
}

function regularPaymentsQuery(orgId: number, start: Date, end: Date) {
  return db<PaymentRow>("tb_payments")
    .join("tb_parking_sessions", "tb_parking_sessions.id", "tb_payments.session_id")
    .where("tb_payments.org_id", orgId)
    .andWhere("tb_parking_sessions.session_source", "regular")
    .whereBetween("tb_payments.paid_at", [start, end])
    .select(
      "tb_payments.paid_at as paid_at",
      "tb_payments.amount as amount",
      "tb_parking_sessions.payment_method as payment_method"
    );
}

function splitRevenueByPaymentMethod(paymentsRows: PaymentRow[]): {
  cashRevenue: number;
  onlineRevenue: number;
} {
  let cashRevenue = 0;
  let onlineRevenue = 0;
  for (const row of paymentsRows) {
    if (row.payment_method === "online") {
      onlineRevenue += Number(row.amount);
    } else {
      cashRevenue += Number(row.amount);
    }
  }
  return { cashRevenue, onlineRevenue };
}

async function getSubscriptionRevenue(
  orgId: number,
  createdStart: Date,
  createdEnd: Date,
  renewedStartDate: string,
  renewedEndDate: string
): Promise<number> {
  const [{ total }] = await db("tb_subscriptions")
    .where({ org_id: orgId })
    .andWhere((builder) => {
      builder
        .whereBetween("created_at", [createdStart, createdEnd])
        .orWhereBetween("last_renewed_at", [renewedStartDate, renewedEndDate]);
    })
    .sum<{ total: string | null }[]>("price_snapshot as total");
  return Number(total ?? 0);
}

export async function getDailyReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  dateParam: string | undefined
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

  const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf("day").toJSDate();
  const dayEnd = DateTime.fromISO(date, { zone: timezone }).endOf("day").toJSDate();

  const [entriesRows, exitsRows, paymentsRows, [{ count: currentlyParked }], subscriptionRevenue] =
    await Promise.all([
      db<SessionTimeRow>("tb_parking_sessions")
        .where({ org_id: orgId })
        .whereBetween("entered_at", [dayStart, dayEnd])
        .select("entered_at"),
      db<SessionTimeRow>("tb_parking_sessions")
        .where({ org_id: orgId })
        .whereNotNull("exited_at")
        .whereBetween("exited_at", [dayStart, dayEnd])
        .select("exited_at"),
      regularPaymentsQuery(orgId, dayStart, dayEnd),
      db("tb_parking_sessions")
        .where({ org_id: orgId, status: "active" })
        .count<{ count: string }[]>("id as count"),
      getSubscriptionRevenue(orgId, dayStart, dayEnd, date, date),
    ]);

  const hourlyEntries = new Array(24).fill(0);
  for (const row of entriesRows) {
    hourlyEntries[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).hour]++;
  }

  const hourlyRevenue = new Array(24).fill(0);
  for (const row of paymentsRows) {
    hourlyRevenue[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).hour] += Number(row.amount);
  }

  const hourlyBreakdown = hourlyEntries.map((entries, hour) => ({
    hour,
    entries,
    revenue: hourlyRevenue[hour],
  }));

  const { cashRevenue, onlineRevenue } = splitRevenueByPaymentMethod(paymentsRows);
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
  monthParam: number | undefined
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
  const monthEnd = monthAnchor.endOf("month").toJSDate();
  const monthStartDate = monthAnchor.startOf("month").toFormat("yyyy-MM-dd");
  const monthEndDate = monthAnchor.endOf("month").toFormat("yyyy-MM-dd");
  const daysInMonth = monthAnchor.daysInMonth as number;

  const [entriesRows, exitsRows, paymentsRows, subscriptionRevenue] = await Promise.all([
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereBetween("entered_at", [monthStart, monthEnd])
      .select("entered_at"),
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereNotNull("exited_at")
      .whereBetween("exited_at", [monthStart, monthEnd])
      .select("exited_at"),
    regularPaymentsQuery(orgId, monthStart, monthEnd),
    getSubscriptionRevenue(orgId, monthStart, monthEnd, monthStartDate, monthEndDate),
  ]);

  const entriesByDay = new Array(daysInMonth + 1).fill(0);
  for (const row of entriesRows) {
    entriesByDay[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).day]++;
  }

  const exitsByDay = new Array(daysInMonth + 1).fill(0);
  for (const row of exitsRows) {
    exitsByDay[DateTime.fromJSDate(new Date(row.exited_at as Date)).setZone(timezone).day]++;
  }

  const revenueByDay = new Array(daysInMonth + 1).fill(0);
  for (const row of paymentsRows) {
    revenueByDay[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).day] += Number(row.amount);
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
    total_revenue: regularRevenue + subscriptionRevenue,
    daily_breakdown: dailyBreakdown,
  };
}

export async function getYearlyReport(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  yearParam: number | undefined
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
  const yearEnd = yearAnchor.endOf("year").toJSDate();
  const yearStartDate = yearAnchor.startOf("year").toFormat("yyyy-MM-dd");
  const yearEndDate = yearAnchor.endOf("year").toFormat("yyyy-MM-dd");

  const [entriesRows, exitsRows, paymentsRows, subscriptionRevenue] = await Promise.all([
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereBetween("entered_at", [yearStart, yearEnd])
      .select("entered_at"),
    db<SessionTimeRow>("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereNotNull("exited_at")
      .whereBetween("exited_at", [yearStart, yearEnd])
      .select("exited_at"),
    regularPaymentsQuery(orgId, yearStart, yearEnd),
    getSubscriptionRevenue(orgId, yearStart, yearEnd, yearStartDate, yearEndDate),
  ]);

  const entriesByMonth = new Array(13).fill(0);
  for (const row of entriesRows) {
    entriesByMonth[DateTime.fromJSDate(new Date(row.entered_at)).setZone(timezone).month]++;
  }

  const exitsByMonth = new Array(13).fill(0);
  for (const row of exitsRows) {
    exitsByMonth[DateTime.fromJSDate(new Date(row.exited_at as Date)).setZone(timezone).month]++;
  }

  const revenueByMonth = new Array(13).fill(0);
  for (const row of paymentsRows) {
    revenueByMonth[DateTime.fromJSDate(new Date(row.paid_at)).setZone(timezone).month] += Number(row.amount);
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
    total_revenue: regularRevenue + subscriptionRevenue,
    monthly_breakdown: monthlyBreakdown,
  };
}
