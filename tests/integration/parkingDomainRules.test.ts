import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  clearAllActiveSessions,
  entryManual,
  getCapacity,
} from "@/modules/parking/parking.service";
import { getOrganizationStats } from "@/modules/organizations/organizations.service";
import { getDisplayStatus } from "@/modules/publicDisplay/publicDisplay.service";
import { getDailyReport } from "@/modules/reports/reports.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
  setOrgCapacity,
} from "./helpers";

let orgId: number;
let otherOrgId: number;
let operator: AuthTokenPayload;

async function insertSession(input: {
  orgId?: number;
  plate: string;
  status: "active" | "awaiting_payment" | "completed";
  source?: "regular" | "subscription" | "vip";
  amount?: number;
  enteredAt?: Date;
  exitedAt?: Date | null;
}): Promise<number> {
  const targetOrgId = input.orgId ?? orgId;
  const inside = input.status === "active" || input.status === "awaiting_payment";
  const [id] = await db("tb_parking_sessions").insert({
    org_id: targetOrgId,
    plate_number: input.plate,
    entered_at: input.enteredAt ?? new Date(),
    exited_at: input.exitedAt ?? (input.status === "active" ? null : new Date()),
    duration_minutes: input.status === "active" ? null : 10,
    amount: input.amount ?? 0,
    status: input.status,
    entry_method: "manual",
    exit_method: input.status === "active" ? null : "manual",
    session_source: input.source ?? "regular",
    active_plate_key: inside ? `${targetOrgId}:${input.plate}` : null,
  });
  return id;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestSettings(orgId, { work_hours_enabled: false });
  const user = await createTestUser(orgId, { role: "operator" });
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(async () => {
  await closeDb();
});

describe("parking fizik bandlik va statistik domen qoidalari", () => {
  it("regular/subscription/vip active va awaiting_payment band, faqat completed exit hisoblanadi", async () => {
    const now = new Date();
    await insertSession({ plate: "REG-ACTIVE", status: "active", source: "regular", enteredAt: now });
    await insertSession({ plate: "SUB-ACTIVE", status: "active", source: "subscription", enteredAt: now });
    await insertSession({ plate: "VIP-ACTIVE", status: "active", source: "vip", enteredAt: now });
    await insertSession({
      plate: "REG-WAITING",
      status: "awaiting_payment",
      source: "regular",
      amount: 999999,
      enteredAt: now,
      exitedAt: now,
    });
    await insertSession({ plate: "DONE", status: "completed", enteredAt: now, exitedAt: now });
    await insertSession({
      orgId: otherOrgId,
      plate: "OTHER-ORG",
      status: "active",
      enteredAt: now,
    });

    await setOrgCapacity(orgId, 10);
    expect(await getCapacity(operator)).toEqual({ occupied: 4, total: 10, available: 6 });

    const display = await getDisplayStatus(orgId);
    expect(display.capacity).toEqual({ occupied: 4, total: 10, available: 6 });

    const date = DateTime.now().setZone("UTC").toFormat("yyyy-MM-dd");
    const report = await getDailyReport(operator, undefined, date);
    expect(report.total_entries).toBe(5);
    expect(report.total_exits).toBe(1);
    expect(report.currently_parked).toBe(4);

    const stats = await getOrganizationStats(orgId);
    expect(stats.today_entries).toBe(5);
    expect(stats.today_exits).toBe(1);
    expect(stats.currently_parked).toBe(4);
  });

  it("awaiting_payment plate uchun yangi kirishni bloklaydi va capacityni to'ldiradi", async () => {
    await setOrgCapacity(orgId, 2);
    await insertSession({ plate: "WAITING-PLATE", status: "awaiting_payment" });

    await expect(entryManual(operator, { plate_number: "WAITING-PLATE" })).rejects.toMatchObject({
      statusCode: 409,
    });

    await insertSession({ plate: "ACTIVE-PLATE", status: "active" });
    await expect(entryManual(operator, { plate_number: "NEW-PLATE" })).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: "parking_full" },
    });
  });

  it("awaiting amount daromad emas, regular revenue faqat tb_paymentsdan olinadi", async () => {
    const now = new Date();
    await insertSession({
      plate: "UNPAID",
      status: "awaiting_payment",
      amount: 500000,
      enteredAt: now,
      exitedAt: now,
    });
    const paidSessionId = await insertSession({
      plate: "PAID",
      status: "completed",
      amount: 7000,
      enteredAt: now,
      exitedAt: now,
    });
    await db("tb_payments").insert({
      org_id: orgId,
      session_id: paidSessionId,
      amount: 7000,
      payment_method: "cash",
      paid_at: now,
    });

    const date = DateTime.now().setZone("UTC").toFormat("yyyy-MM-dd");
    const report = await getDailyReport(operator, undefined, date);
    expect(report.regular_revenue).toBe(7000);
    expect(report.total_revenue).toBe(7000);
  });

  it("clear-test begona org_id'ni rad etib actor tashkilotidagi inside sessiyalarni yakunlaydi", async () => {
    const activeId = await insertSession({ plate: "CLEAR-ACTIVE", status: "active" });
    const waitingId = await insertSession({ plate: "CLEAR-WAITING", status: "awaiting_payment" });
    const otherId = await insertSession({
      orgId: otherOrgId,
      plate: "KEEP-OTHER",
      status: "active",
    });

    await expect(clearAllActiveSessions(operator, otherOrgId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await db("tb_parking_sessions").where({ id: otherId }).first()).status).toBe("active");

    await expect(clearAllActiveSessions(operator)).resolves.toEqual({ cleared: 2 });

    const cleared = await db("tb_parking_sessions").whereIn("id", [activeId, waitingId]).orderBy("id");
    expect(cleared.every((session) => session.status === "completed")).toBe(true);
    expect(cleared.every((session) => session.active_plate_key === null)).toBe(true);
    expect((await db("tb_parking_sessions").where({ id: otherId }).first()).status).toBe("active");

    const activity = await db("tb_activity_logs")
      .where({ actor_id: operator.id, action: "parking.test_sessions_cleared", target_id: orgId })
      .first();
    expect(activity).toBeTruthy();
  });

  it("super admin clear-test uchun aniq org_id berishi shart", async () => {
    const superAdmin: AuthTokenPayload = { id: 1, org_id: null, role: "super_admin" };
    await expect(clearAllActiveSessions(superAdmin)).rejects.toMatchObject({ statusCode: 400 });
  });
});
