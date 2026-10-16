import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { getOrgTodayDate, getOrgTodayRange } from "@/modules/medplus/medplus.service";
import { runStaleSessionsCleanup } from "@/modules/maintenance/staleSessionsCleanup.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestAwaitingPaymentSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

let orgId: number;
let otherOrgId: number;
let actorId: number;

function cutoffFor(timezone: string): DateTime {
  return DateTime.fromJSDate(getOrgTodayRange(timezone).start)
    .setZone(timezone)
    .minus({ days: env.staleSessionCleanup.keepDays - 1 });
}

async function createSession(input: {
  targetOrgId?: number;
  plate: string;
  enteredAt: Date;
  status?: "active" | "completed";
  source?: "regular" | "vip" | "subscription";
}): Promise<number> {
  const id = await createTestActiveSession(input.targetOrgId ?? orgId, input.plate, input.enteredAt);
  await db("tb_parking_sessions").where({ id }).update({
    status: input.status ?? "active",
    session_source: input.source ?? "regular",
    active_plate_key: input.status === "completed" ? null : `${input.targetOrgId ?? orgId}:${input.plate}`,
  });
  return id;
}

async function addTerminalOperation(sessionId: number, status: string): Promise<number> {
  const [id] = await db("payment_terminal_operations").insert({
    org_id: orgId,
    session_id: sessionId,
    operation_number: `${Date.now()}${Math.random()}`.replace(/\D/g, "").slice(-8),
    requested_amount_som: 10000,
    sent_amount_minor: 1000000,
    status,
  });
  return id;
}

async function oldSession(plate: string, targetOrgId = orgId, timezone = "Asia/Tashkent") {
  return createSession({
    targetOrgId,
    plate,
    enteredAt: cutoffFor(timezone).minus({ minutes: 1 }).toJSDate(),
  });
}

beforeAll(async () => {
  await assertTestDatabase();
  await db.schema.dropTableIfExists("test_stale_session_restrict");
  await db.schema.createTable("test_stale_session_restrict", (table) => {
    table.increments("id").primary();
    table.integer("session_id").unsigned().notNullable();
    table
      .foreign("session_id", "fk_test_stale_session_restrict")
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("RESTRICT");
  });
});

beforeEach(async () => {
  env.staleSessionCleanup.keepDays = 2;
  env.staleSessionCleanup.maxPerRun = 1000;
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "America/New_York" });
  actorId = (await createTestUser(orgId, { role: "owner" })).id;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await db("test_stale_session_restrict").del();
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.schema.dropTableIfExists("test_stale_session_restrict");
  await closeDb();
});

describe("stale session cleanup", () => {
  it("cutoffdan oldingi active regular sessiyani o'chiradi", async () => {
    const sessionId = await oldSession("01OLD001");
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeUndefined();
    expect(summary.deleted_sessions).toBe(1);
  });

  it("exit_cancelled nomzod va uning webhook yozuviga tegmaydi", async () => {
    const sessionId = await oldSession("01OLD002");
    const resolvedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const [eventId] = await db("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: null,
      direction: "exit",
      camera_event_at: resolvedAt,
      created_at: resolvedAt,
    });
    const [candidateId] = await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: eventId,
      detected_plate: null,
      camera_event_at: resolvedAt,
      status: "dismissed",
      resolution_type: "exit_cancelled",
      resolved_by: actorId,
      resolved_at: resolvedAt,
    });

    await runStaleSessionsCleanup();

    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeUndefined();
    expect(await db("tb_exit_candidates").where({ id: candidateId }).first()).toBeDefined();
    expect(await db("tb_webhook_events").where({ id: eventId }).first()).toBeDefined();
  });

  it("kecha va bugungi active regular sessiyalarni saqlaydi", async () => {
    const cutoff = cutoffFor("Asia/Tashkent");
    const yesterday = await createSession({ plate: "01KEEP01", enteredAt: cutoff.plus({ hours: 1 }).toJSDate() });
    const today = await createSession({ plate: "01KEEP02", enteredAt: cutoff.plus({ days: 1, hours: 1 }).toJSDate() });
    await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").whereIn("id", [yesterday, today])).toHaveLength(2);
  });

  it("completed, awaiting_payment, VIP va subscription sessiyalarni saqlaydi", async () => {
    const enteredAt = cutoffFor("Asia/Tashkent").minus({ days: 1 }).toJSDate();
    const completed = await createSession({ plate: "01DONE01", enteredAt, status: "completed" });
    const awaiting = await createTestAwaitingPaymentSession(orgId, "01WAIT01", { enteredAt });
    const vip = await createSession({ plate: "01VIP001", enteredAt, source: "vip" });
    const subscription = await createSession({ plate: "01SUB001", enteredAt, source: "subscription" });
    await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").whereIn("id", [completed, awaiting, vip, subscription])).toHaveLength(4);
  });

  it("har organization uchun o'z timezone cutoffini ishlatadi", async () => {
    const tashkentOld = await oldSession("01TZ0001", orgId, "Asia/Tashkent");
    const newYorkOld = await oldSession("01TZ0002", otherOrgId, "America/New_York");
    const tashkentKeep = await createSession({
      plate: "01TZ0003",
      enteredAt: cutoffFor("Asia/Tashkent").plus({ minutes: 1 }).toJSDate(),
    });
    const newYorkKeep = await createSession({
      targetOrgId: otherOrgId,
      plate: "01TZ0004",
      enteredAt: cutoffFor("America/New_York").plus({ minutes: 1 }).toJSDate(),
    });
    await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").whereIn("id", [tashkentOld, newYorkOld])).toHaveLength(0);
    expect(await db("tb_parking_sessions").whereIn("id", [tashkentKeep, newYorkKeep])).toHaveLength(2);
  });

  it("active statsionar bemor mashinasini saqlaydi", async () => {
    const sessionId = await oldSession("01PAT001");
    await db("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: "01PAT001",
      valid_from: getOrgTodayDate("Asia/Tashkent"),
      valid_until: getOrgTodayDate("Asia/Tashkent"),
      status: "active",
    });
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeDefined();
    expect(summary.skipped.inpatient).toBe(1);
  });

  it("tb_payments yozuvi bor sessiyani saqlaydi", async () => {
    const sessionId = await oldSession("01PAY001");
    await db("tb_payments").insert({
      org_id: orgId,
      session_id: sessionId,
      amount: 10000,
      payment_method: "cash",
    });
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeDefined();
    expect(summary.skipped.payment).toBe(1);
  });

  it.each(["APPROVED", "FIN_FAILED", "ORPHANED"])("%s terminal operation sessiyani saqlaydi", async (status) => {
    const sessionId = await oldSession(`01${status}`.slice(0, 20));
    await addTerminalOperation(sessionId, status);
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeDefined();
    expect(summary.skipped.terminal).toBe(1);
  });

  it("himoyalanmagan terminal operation va barcha belgilangan bog'liq yozuvlarni tartib bilan o'chiradi", async () => {
    const sessionId = await oldSession("01REL001");
    const [exitEventMatched] = await db("tb_webhook_events").insert({
      org_id: orgId,
      direction: "exit",
      session_id: sessionId,
    });
    const [exitEventResolved] = await db("tb_webhook_events").insert({
      org_id: orgId,
      direction: "exit",
      session_id: sessionId,
    });
    await db("tb_exit_candidates").insert([
      {
        org_id: orgId,
        webhook_event_id: exitEventMatched,
        matched_session_id: sessionId,
        camera_event_at: new Date(),
      },
      {
        org_id: orgId,
        webhook_event_id: exitEventResolved,
        resolved_session_id: sessionId,
        camera_event_at: new Date(),
      },
    ]);
    const [entryEvent] = await db("tb_webhook_events").insert({
      org_id: orgId,
      direction: "entry",
      session_id: sessionId,
    });
    await db("tb_entry_candidates").insert({
      org_id: orgId,
      webhook_event_id: entryEvent,
      detected_plate: "01REL001",
      camera_event_at: new Date(),
      resolved_session_id: sessionId,
    });
    await db("tb_activity_logs").insert({
      actor_id: actorId,
      action: "test.stale",
      target_type: "session",
      target_id: sessionId,
    });
    const operationId = await addTerminalOperation(sessionId, "DECLINED");
    const [transactionId] = await db("tb_payment_transactions").insert({
      org_id: orgId,
      session_id: sessionId,
      provider: "payme",
      provider_transaction_id: `stale-${Date.now()}`,
      amount: 10000,
    });
    const [discountId] = await db("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: "01REL001",
      discount_percent: 10,
      status: "used",
      used_session_id: sessionId,
    });
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_exit_candidates").whereIn("webhook_event_id", [exitEventMatched, exitEventResolved])).toHaveLength(0);
    expect(await db("tb_entry_candidates").where({ webhook_event_id: entryEvent })).toHaveLength(0);
    expect(await db("tb_webhook_events").whereIn("id", [exitEventMatched, exitEventResolved, entryEvent])).toHaveLength(0);
    expect(await db("tb_activity_logs").where({ target_type: "session", target_id: sessionId })).toHaveLength(0);
    expect(await db("payment_terminal_operations").where({ id: operationId })).toHaveLength(0);
    expect((await db("tb_payment_transactions").where({ id: transactionId }).first()).session_id).toBeNull();
    expect((await db("tb_clinic_discounts").where({ id: discountId }).first()).used_session_id).toBeNull();
    expect(summary.deleted_sessions).toBe(1);
  });

  it("deletable son maxdan oshsa organization uchun hech narsa o'chirmaydi", async () => {
    env.staleSessionCleanup.maxPerRun = 1;
    const first = await oldSession("01MAX001");
    const second = await oldSession("01MAX002");
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").whereIn("id", [first, second])).toHaveLength(2);
    expect(summary.limit_exceeded_orgs).toBe(1);
  });

  it("bir organization xatosini rollback qiladi va keyingi organizationni davom ettiradi", async () => {
    const blocked = await oldSession("01ROLL01");
    const deletable = await oldSession("01ROLL02", otherOrgId, "America/New_York");
    const [eventId] = await db("tb_webhook_events").insert({
      org_id: orgId,
      direction: "exit",
      session_id: blocked,
    });
    await db("test_stale_session_restrict").insert({ session_id: blocked });
    const summary = await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: blocked }).first()).toBeDefined();
    expect(await db("tb_webhook_events").where({ id: eventId }).first()).toBeDefined();
    expect(await db("tb_parking_sessions").where({ id: deletable }).first()).toBeUndefined();
    expect(summary.failed_orgs).toBe(1);
    expect(summary.deleted_sessions).toBe(1);
  });

  it("takroriy ishga tushirishda ikkinchi run nol sessiya o'chiradi", async () => {
    await oldSession("01IDEM01");
    const first = await runStaleSessionsCleanup();
    const second = await runStaleSessionsCleanup();
    expect(first.deleted_sessions).toBe(1);
    expect(second.deleted_sessions).toBe(0);
  });

  it("active regular bo'lmagan target va uning bog'liq yozuvlariga tegmaydi", async () => {
    const sessionId = await createSession({
      plate: "01GUARD1",
      enteredAt: cutoffFor("Asia/Tashkent").minus({ days: 1 }).toJSDate(),
      status: "completed",
    });
    const [eventId] = await db("tb_webhook_events").insert({
      org_id: orgId,
      direction: "exit",
      session_id: sessionId,
    });
    await db("tb_activity_logs").insert({
      actor_id: actorId,
      action: "test.guard",
      target_type: "session",
      target_id: sessionId,
    });
    await runStaleSessionsCleanup();
    expect(await db("tb_parking_sessions").where({ id: sessionId }).first()).toBeDefined();
    expect(await db("tb_webhook_events").where({ id: eventId }).first()).toBeDefined();
    expect(await db("tb_activity_logs").where({ target_type: "session", target_id: sessionId })).toHaveLength(1);
  });
});
