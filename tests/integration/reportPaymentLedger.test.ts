import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  acceptEntryCandidate,
  createManualEntry,
} from "@/modules/entryCandidates/entryCandidates.service";
import { resetOrganizationTestData } from "@/modules/organizations/organizationTestDataReset.service";
import {
  getDailyRangeReport,
  getDailyReport,
  getMonthlyReport,
  getYearlyReport,
} from "@/modules/reports/reports.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { runBackup } from "@/scripts/backup";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true, detail: "opened" }),
}));

vi.mock("@/websocket/socketServer", () => ({
  emitEntryBarrierFailed: vi.fn(),
  emitEntryCandidateCreated: vi.fn(),
  emitEntryCandidateResolved: vi.fn(),
  emitEntryCompleted: vi.fn(),
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
}));

vi.mock("@/scripts/backup", () => ({ runBackup: vi.fn() }));

const ZONE = "Asia/Tashkent";

let orgId: number;
let otherOrgId: number;
let actor: AuthTokenPayload;

function localDateTime(days: number, hour: number, minute = 0): DateTime {
  return DateTime.now().setZone(ZONE).startOf("day").plus({ days, hours: hour, minutes: minute });
}

async function createCompletedSession(input: {
  targetOrgId?: number;
  plate: string;
  enteredAt: Date;
  exitedAt: Date;
  source?: "regular" | "subscription" | "vip";
  sessionAmount?: number;
  payment?: { amount: number; method: "cash" | "online"; paidAt: Date };
}) {
  const targetOrgId = input.targetOrgId ?? orgId;
  const [sessionId] = await db("tb_parking_sessions").insert({
    org_id: targetOrgId,
    plate_number: input.plate,
    entered_at: input.enteredAt,
    exited_at: input.exitedAt,
    duration_minutes: Math.max(0, Math.round((input.exitedAt.getTime() - input.enteredAt.getTime()) / 60000)),
    amount: input.sessionAmount ?? input.payment?.amount ?? 0,
    status: "completed",
    entry_method: "manual",
    exit_method: "manual",
    session_source: input.source ?? "regular",
    payment_method: input.payment?.method ?? "cash",
  });
  if (input.payment) {
    await db("tb_payments").insert({
      org_id: targetOrgId,
      session_id: sessionId,
      amount: input.payment.amount,
      payment_method: input.payment.method,
      paid_at: input.payment.paidAt,
    });
  }
  return sessionId;
}

async function createSubscriptionRevenue(amount: number, createdAt: Date) {
  const localDate = DateTime.fromJSDate(createdAt).setZone(ZONE);
  await db("tb_subscriptions").insert({
    org_id: orgId,
    plan_id: null,
    plate_number: `SUB${Date.now()}`,
    plan_name_snapshot: "Hisobot obunasi",
    price_snapshot: amount,
    duration_days_snapshot: 30,
    start_date: localDate.toFormat("yyyy-MM-dd"),
    end_date: localDate.plus({ days: 30 }).toFormat("yyyy-MM-dd"),
    created_at: createdAt,
  });
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: ZONE });
  otherOrgId = await createTestOrganization({ timezone: ZONE });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestTariff(otherOrgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
  vi.mocked(openBarrier).mockReset().mockResolvedValue({
    status: "opened",
    success: true,
    detail: "opened",
  });
  vi.mocked(runBackup).mockReset().mockResolvedValue("/tmp/stoyanka-report-reset.sql.gz");
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("report payment ledger", () => {
  it("1. daily report cash va online to'lovlarni tb_payments bo'yicha ajratadi", async () => {
    const paidAt = localDateTime(-1, 12).toJSDate();
    await createCompletedSession({
      plate: "LEDGER001",
      enteredAt: localDateTime(-1, 9).toJSDate(),
      exitedAt: localDateTime(-1, 10).toJSDate(),
      sessionAmount: 900000,
      payment: { amount: 5000, method: "cash", paidAt },
    });
    await createCompletedSession({
      plate: "LEDGER002",
      enteredAt: localDateTime(-1, 10).toJSDate(),
      exitedAt: localDateTime(-1, 11).toJSDate(),
      sessionAmount: 800000,
      payment: { amount: 7000, method: "online", paidAt },
    });
    const report = await getDailyReport(actor, undefined, localDateTime(-1, 0).toFormat("yyyy-MM-dd"));
    expect(report.cash_revenue).toBe(5000);
    expect(report.online_revenue).toBe(7000);
    expect(report.total_revenue).toBe(12000);
  });

  it("2. daily report VIP sessiya summasini revenue sifatida hisoblamaydi", async () => {
    await createCompletedSession({
      plate: "VIPLEDGER",
      enteredAt: localDateTime(-1, 9).toJSDate(),
      exitedAt: localDateTime(-1, 10).toJSDate(),
      source: "vip",
      sessionAmount: 100000,
    });
    const report = await getDailyReport(actor, undefined, localDateTime(-1, 0).toFormat("yyyy-MM-dd"));
    expect(report.vip_revenue).toBe(0);
    expect(report.total_revenue).toBe(0);
  });

  it("3. daily report subscription yaratish revenue'sini saqlangan model bo'yicha hisoblaydi", async () => {
    await createSubscriptionRevenue(150000, localDateTime(-1, 13).toJSDate());
    const report = await getDailyReport(actor, undefined, localDateTime(-1, 0).toFormat("yyyy-MM-dd"));
    expect(report.subscription_revenue).toBe(150000);
    expect(report.total_revenue).toBe(150000);
  });

  it("4. monthly report turli kunlardagi ledger to'lovlarini yig'adi", async () => {
    const month = DateTime.now().setZone(ZONE).startOf("month");
    for (const [index, method] of (["cash", "online"] as const).entries()) {
      const paidAt = month.plus({ days: index, hours: 14 }).toJSDate();
      await createCompletedSession({
        plate: `MONTH${index}`,
        enteredAt: month.plus({ days: index, hours: 10 }).toJSDate(),
        exitedAt: month.plus({ days: index, hours: 11 }).toJSDate(),
        payment: { amount: index === 0 ? 4000 : 6000, method, paidAt },
      });
    }
    const report = await getMonthlyReport(actor, undefined, month.year, month.month);
    expect(report.cash_revenue).toBe(4000);
    expect(report.online_revenue).toBe(6000);
    expect(report.total_revenue).toBe(10000);
  });

  it("5. yearly report turli oylardagi ledger to'lovlarini yig'adi", async () => {
    const year = DateTime.now().setZone(ZONE).startOf("year");
    const january = year.plus({ days: 10, hours: 12 });
    const july = year.plus({ months: 6, days: 10, hours: 12 });
    await createCompletedSession({
      plate: "YEAR001",
      enteredAt: january.minus({ hours: 2 }).toJSDate(),
      exitedAt: january.minus({ hours: 1 }).toJSDate(),
      payment: { amount: 8000, method: "cash", paidAt: january.toJSDate() },
    });
    await createCompletedSession({
      plate: "YEAR002",
      enteredAt: july.minus({ hours: 2 }).toJSDate(),
      exitedAt: july.minus({ hours: 1 }).toJSDate(),
      payment: { amount: 9000, method: "online", paidAt: july.toJSDate() },
    });
    const report = await getYearlyReport(actor, undefined, year.year);
    expect(report.cash_revenue).toBe(8000);
    expect(report.online_revenue).toBe(9000);
    expect(report.total_revenue).toBe(17000);
  });

  it("6. daily range ixtiyoriy mahalliy sana oralig'ini ledger bo'yicha hisoblaydi", async () => {
    for (const [day, amount] of [[-2, 3000], [0, 7000]] as const) {
      await createCompletedSession({
        plate: `RANGE${day}`,
        enteredAt: localDateTime(day, 8).toJSDate(),
        exitedAt: localDateTime(day, 9).toJSDate(),
        payment: { amount, method: day === -2 ? "cash" : "online", paidAt: localDateTime(day, 10).toJSDate() },
      });
    }
    const report = await getDailyRangeReport(
      actor,
      undefined,
      localDateTime(-2, 0).toFormat("yyyy-MM-dd"),
      localDateTime(0, 0).toFormat("yyyy-MM-dd")
    );
    expect(report.items).toHaveLength(3);
    expect(report.cash_revenue).toBe(3000);
    expect(report.online_revenue).toBe(7000);
    expect(report.total_revenue).toBe(10000);
  });

  it("7. Asia/Tashkent 23:50 dagi to'lovni UTC emas, mahalliy kunga biriktiradi", async () => {
    const localDay = localDateTime(-1, 0);
    await createCompletedSession({
      plate: "TZ2350",
      enteredAt: localDay.plus({ hours: 21 }).toJSDate(),
      exitedAt: localDay.plus({ hours: 22 }).toJSDate(),
      payment: { amount: 11000, method: "online", paidAt: localDay.plus({ hours: 23, minutes: 50 }).toJSDate() },
    });
    const report = await getDailyReport(actor, undefined, localDay.toFormat("yyyy-MM-dd"));
    expect(report.online_revenue).toBe(11000);
    expect(report.hourly_breakdown[23].revenue).toBe(11000);
  });

  it("8. boshqa organization ledger to'lovlarini hisobotga aralashtirmaydi", async () => {
    const paidAt = localDateTime(-1, 12).toJSDate();
    await createCompletedSession({
      plate: "ORGOWN",
      enteredAt: localDateTime(-1, 9).toJSDate(),
      exitedAt: localDateTime(-1, 10).toJSDate(),
      payment: { amount: 5000, method: "cash", paidAt },
    });
    await createCompletedSession({
      targetOrgId: otherOrgId,
      plate: "ORGOTHER",
      enteredAt: localDateTime(-1, 9).toJSDate(),
      exitedAt: localDateTime(-1, 10).toJSDate(),
      payment: { amount: 99000, method: "online", paidAt },
    });
    const report = await getDailyReport(actor, undefined, localDateTime(-1, 0).toFormat("yyyy-MM-dd"));
    expect(report.cash_revenue).toBe(5000);
    expect(report.online_revenue).toBe(0);
    expect(report.total_revenue).toBe(5000);
  });

  it("9. entry candidate accept yaratgan sessiyani total_entries ga qo'shadi", async () => {
    const eventAt = localDateTime(0, 9).toJSDate();
    const [webhookEventId] = await db("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: "CANDREPORT",
      direction: "entry",
      camera_event_at: eventAt,
    });
    const [candidateId] = await db("tb_entry_candidates").insert({
      org_id: orgId,
      webhook_event_id: webhookEventId,
      detected_plate: "CANDREPORT",
      confidence: 95,
      camera_event_at: eventAt,
      reason: "capacity_full",
    });
    await acceptEntryCandidate(actor, undefined, candidateId, { plateNumber: "CANDREPORT" });
    const report = await getDailyReport(actor, undefined, localDateTime(0, 0).toFormat("yyyy-MM-dd"));
    expect(report.total_entries).toBe(1);
  });

  it("10. manual entry yaratgan sessiyani total_entries ga qo'shadi", async () => {
    await createManualEntry(actor, undefined, { plateNumber: "MANREPORT", reason: "camera_offline" });
    const report = await getDailyReport(actor, undefined, localDateTime(0, 0).toFormat("yyyy-MM-dd"));
    expect(report.total_entries).toBe(1);
  });

  it("11. resetdan keyin daily, monthly, yearly va range operational reportlari noldan boshlanadi", async () => {
    const now = localDateTime(0, 12);
    await createCompletedSession({
      plate: "RESETREPORT",
      enteredAt: now.minus({ hours: 2 }).toJSDate(),
      exitedAt: now.minus({ hours: 1 }).toJSDate(),
      payment: { amount: 12000, method: "cash", paidAt: now.toJSDate() },
    });
    await resetOrganizationTestData(orgId, actor.id);
    const date = now.toFormat("yyyy-MM-dd");
    const [daily, monthly, yearly, range] = await Promise.all([
      getDailyReport(actor, undefined, date),
      getMonthlyReport(actor, undefined, now.year, now.month),
      getYearlyReport(actor, undefined, now.year),
      getDailyRangeReport(actor, undefined, date, date),
    ]);
    for (const report of [daily, monthly, yearly, range]) {
      expect(report.total_entries).toBe(0);
      expect(report.total_exits).toBe(0);
      expect(report.cash_revenue).toBe(0);
      expect(report.online_revenue).toBe(0);
      expect(report.subscription_revenue).toBe(0);
      expect(report.vip_revenue).toBe(0);
      expect(report.total_revenue).toBe(0);
    }
  });
});
