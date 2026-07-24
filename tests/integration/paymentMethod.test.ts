import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  entryManual,
  exitManual,
  forceCloseSession,
  updateSessionPaymentMethod,
} from "@/modules/parking/parking.service";
import { getDailyReport } from "@/modules/reports/reports.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestSettings(orgId, { work_hours_enabled: false });
  const user = await createTestUser(orgId);
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb();
});

async function enterNow(plate: string) {
  const entryTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(entryTime);
  const session = await entryManual(operator, { plate_number: plate });
  return { session, entryTime };
}

function advanceOneHour(entryTime: Date) {
  vi.setSystemTime(new Date(entryTime.getTime() + 60 * 60 * 1000));
}

describe("To'lov turi (payment_method)", () => {
  it("payment_method yuborilmasa — default 'cash' bo'ladi", async () => {
    const plate = "01P100AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    const result = await exitManual(operator, { plate_number: plate });
    vi.useRealTimers();
    expect(result.session.payment_method).toBe("cash");
  });

  it("naqd to'lov bilan yopilgan sessiya — cash_revenue ga qo'shiladi", async () => {
    const plate = "01P101AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    await exitManual(operator, { plate_number: plate, payment_method: "cash" });
    vi.useRealTimers();

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.cash_revenue).toBe(5000);
    expect(report.online_revenue).toBe(0);
  });

  it("online to'lov bilan yopilgan sessiya — online_revenue ga qo'shiladi", async () => {
    const plate = "01P102AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    await exitManual(operator, { plate_number: plate, payment_method: "online" });
    vi.useRealTimers();

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.online_revenue).toBe(5000);
    expect(report.cash_revenue).toBe(0);
  });

  it("regular_revenue = cash_revenue + online_revenue", async () => {
    const plateCash = "01P103AA";
    const plateOnline = "01P104AA";

    const cashEntry = await enterNow(plateCash);
    advanceOneHour(cashEntry.entryTime);
    await exitManual(operator, { plate_number: plateCash, payment_method: "cash" });
    vi.useRealTimers();

    const onlineEntry = await enterNow(plateOnline);
    advanceOneHour(onlineEntry.entryTime);
    await exitManual(operator, { plate_number: plateOnline, payment_method: "online" });
    vi.useRealTimers();

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.regular_revenue).toBe(report.cash_revenue + report.online_revenue);
    expect(report.regular_revenue).toBe(10000);
  });

  it("forceCloseSession ham payment_method qabul qiladi", async () => {
    const plate = "01P105AA";
    const { session, entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    const result = await forceCloseSession(operator, session!.id, { payment_method: "online" });
    vi.useRealTimers();
    expect(result.session?.payment_method).toBe("online");
  });

  it("noto'g'ri payment_method uchun forceCloseSession 400 xato", async () => {
    const plate = "01P106AA";
    const { session, entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    await expect(
      forceCloseSession(operator, session!.id, { payment_method: "crypto" as unknown as "cash" })
    ).rejects.toMatchObject({ statusCode: 400 });
    vi.useRealTimers();
  });
});

describe("updateSessionPaymentMethod — avtomatik yopilgan sessiya uchun keyinroq to'lov turini belgilash", () => {
  it("yopilgan sessiyaning payment_method'ini 'online'ga yangilaydi", async () => {
    const plate = "01P200AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    const exitResult = await exitManual(operator, { plate_number: plate });
    vi.useRealTimers();
    expect(exitResult.session.payment_method).toBe("cash");

    const updated = await updateSessionPaymentMethod(operator, exitResult.session.id, "online");
    expect(updated?.payment_method).toBe("online");
  });

  it("yangilangan payment_method hisobotda to'g'ri joyga tushadi", async () => {
    const plate = "01P201AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    const exitResult = await exitManual(operator, { plate_number: plate, payment_method: "cash" });
    vi.useRealTimers();

    const reportBefore = await getDailyReport(operator, undefined, undefined);
    expect(reportBefore.cash_revenue).toBe(5000);
    expect(reportBefore.online_revenue).toBe(0);

    await updateSessionPaymentMethod(operator, exitResult.session.id, "online");

    const reportAfter = await getDailyReport(operator, undefined, undefined);
    expect(reportAfter.cash_revenue).toBe(0);
    expect(reportAfter.online_revenue).toBe(5000);
    expect(reportAfter.regular_revenue).toBe(reportAfter.cash_revenue + reportAfter.online_revenue);
  });

  it("hali FAOL (yopilmagan) sessiya uchun 400 xato", async () => {
    const plate = "01P202AA";
    const { session } = await enterNow(plate);
    vi.useRealTimers();
    await expect(updateSessionPaymentMethod(operator, session!.id, "online")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("boshqa org operatori uchun 404 xato", async () => {
    const plate = "01P203AA";
    const { entryTime } = await enterNow(plate);
    advanceOneHour(entryTime);
    const exitResult = await exitManual(operator, { plate_number: plate });
    vi.useRealTimers();

    const otherOrgId = await createTestOrganization();
    try {
      const otherUser = await createTestUser(otherOrgId, { role: "operator" });
      const otherOperator: AuthTokenPayload = { id: otherUser.id, org_id: otherOrgId, role: "operator" };

      await expect(
        updateSessionPaymentMethod(otherOperator, exitResult.session.id, "online")
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });
});
