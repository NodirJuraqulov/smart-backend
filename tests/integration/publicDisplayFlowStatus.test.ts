import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockedFunction, vi } from "vitest";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { acceptEntryCandidate, declineEntryCandidate } from "@/modules/entryCandidates/entryCandidates.service";
import {
  confirmExitCandidate,
  forceOpenExitCandidate,
} from "@/modules/exitCandidates/exitCandidates.service";
import publicDisplayRouter from "@/modules/publicDisplay/publicDisplay.routes";
import { getDailyReport } from "@/modules/reports/reports.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { errorHandler } from "@/middleware/errorHandler";
import { PublicBarrierStatus } from "@/modules/publicDisplay/publicDisplay.types";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/relay/relay.service")>(
    "@/modules/relay/relay.service"
  );
  return {
    ...actual,
    openBarrier: vi.fn(),
  };
});

const openBarrierMock = openBarrier as MockedFunction<typeof openBarrier>;
const app = express();
app.use(express.json());
app.use("/api/public/display", publicDisplayRouter);
app.use(errorHandler);

let orgId: number;
let actor: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  const user = await createTestUser(orgId);
  actor = { id: user.id, org_id: orgId, role: "operator" };
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  openBarrierMock.mockResolvedValue({ status: "opened", success: true });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

async function createWebhookEvent(direction: "entry" | "exit", plate: string | null): Promise<number> {
  const [id] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plate,
    direction,
    camera_event_at: new Date(),
  });
  return id;
}

async function createEntryCandidate(plate: string | null): Promise<number> {
  const webhookEventId = await createWebhookEvent("entry", plate);
  const [id] = await db("tb_entry_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: plate,
    reason: plate ? "capacity_full" : "plate_not_detected",
    camera_event_at: new Date(),
    status: "pending",
  });
  return id;
}

async function createActiveSession(
  plate: string,
  source: "regular" | "subscription" | "vip" = "regular"
): Promise<number> {
  const enteredAt = new Date(Date.now() - 60 * 60_000);
  const [id] = await db("tb_parking_sessions").insert({
    org_id: orgId,
    plate_number: plate,
    entered_at: enteredAt,
    status: "active",
    entry_method: "auto",
    session_source: source,
    active_plate_key: `${orgId}:${plate}`,
    tariff_price_per_hour: source === "regular" ? 5000 : null,
    tariff_grace_period_minutes: source === "regular" ? 0 : null,
  });
  return id;
}

async function createExitCandidate(plate: string, sessionId: number | null): Promise<number> {
  const webhookEventId = await createWebhookEvent("exit", plate);
  const [id] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: plate,
    matched_session_id: sessionId,
    camera_event_at: new Date(),
    status: "pending",
  });
  return id;
}

async function recordEntryBarrier(sessionId: number, status: PublicBarrierStatus): Promise<void> {
  const action =
    status === "opened"
      ? "parking.entry_barrier_opened"
      : status === "failed"
        ? "parking.entry_barrier_open_failed"
        : "parking.entry_barrier_unavailable";
  await db("tb_activity_logs").insert({
    actor_id: actor.id,
    action,
    target_type: "session",
    target_id: sessionId,
    details: JSON.stringify({ orgId, sessionId, barrierStatus: status, retryAttempt: false }),
  });
}

async function getEntryStatus() {
  return request(app).get(`/api/public/display/${orgId}/entry-status`);
}

async function getExitStatus() {
  return request(app).get(`/api/public/display/${orgId}/exit-status`);
}

describe("public display production state flow", () => {
  it("1. exit event bo'lmasa idle qaytaradi", async () => {
    const response = await getExitStatus();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: "idle", plate: null, barrier_status: null });
  });

  it("2. pending exit candidate awaiting_operator va to'g'ri plate qaytaradi", async () => {
    const sessionId = await createActiveSession("01D002AA");
    await createExitCandidate("01D002AA", sessionId);
    const response = await getExitStatus();
    expect(response.body).toMatchObject({
      state: "awaiting_operator",
      plate: "01D002AA",
      session_source: "regular",
      barrier_status: null,
    });
  });

  it("3. cash confirm completed holatini to'liq qaytaradi", async () => {
    const sessionId = await createActiveSession("01D003AA");
    const candidateId = await createExitCandidate("01D003AA", sessionId);
    await confirmExitCandidate(actor, undefined, candidateId, { paymentMethod: "cash" });
    const response = await getExitStatus();
    expect(response.body).toMatchObject({
      state: "completed",
      plate: "01D003AA",
      session_source: "regular",
      payment_method: "cash",
      barrier_status: "opened",
    });
    expect(response.body.amount).toBeGreaterThan(0);
    expect(response.body.duration_minutes).toBeGreaterThan(0);
  });

  it("4. online confirm payment va activity logda online saqlaydi", async () => {
    const sessionId = await createActiveSession("01D004AA");
    const candidateId = await createExitCandidate("01D004AA", sessionId);
    await confirmExitCandidate(actor, undefined, candidateId, { paymentMethod: "online" });
    const response = await getExitStatus();
    const payment = await db("tb_payments").where({ session_id: sessionId }).first();
    const activity = await db("tb_activity_logs")
      .where({ target_type: "exit_candidate", target_id: candidateId, action: "exit_candidate.accepted" })
      .first();
    const details = typeof activity.details === "string" ? JSON.parse(activity.details) : activity.details;
    expect(response.body.payment_method).toBe("online");
    expect(payment.payment_method).toBe("online");
    expect(details.paymentMethod).toBe("online");
  });

  it("5. VIP confirm amount nol va payment_method null qaytaradi", async () => {
    const sessionId = await createActiveSession("01D005AA", "vip");
    const candidateId = await createExitCandidate("01D005AA", sessionId);
    await confirmExitCandidate(actor, undefined, candidateId, {});
    const response = await getExitStatus();
    const payment = await db("tb_payments").where({ session_id: sessionId }).first();
    expect(response.body).toMatchObject({
      state: "completed",
      session_source: "vip",
      amount: 0,
      payment_method: null,
    });
    expect(payment).toBeUndefined();
  });

  it("6. exit barrier failed holati retrygacha saqlanadi", async () => {
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false, detail: "timeout" });
    const sessionId = await createActiveSession("01D006AA");
    const candidateId = await createExitCandidate("01D006AA", sessionId);
    await confirmExitCandidate(actor, undefined, candidateId, { paymentMethod: "cash" });
    const old = new Date(Date.now() - 60_000);
    await db("tb_exit_candidates").where({ id: candidateId }).update({ resolved_at: old, updated_at: old });
    const response = await getExitStatus();
    expect(response.body).toMatchObject({
      state: "barrier_failed",
      plate: "01D006AA",
      barrier_status: "failed",
    });
  });

  it("7. force-open yakunida declined qaytaradi", async () => {
    const candidateId = await createExitCandidate("01D007AA", null);
    await forceOpenExitCandidate(actor, undefined, candidateId, { reason: "no_session" });
    const response = await getExitStatus();
    expect(response.body).toMatchObject({
      state: "declined",
      plate: "01D007AA",
      barrier_status: "opened",
    });
  });

  it("8. completed exit 15 soniyadan keyin idle bo'ladi", async () => {
    const sessionId = await createActiveSession("01D008AA");
    const candidateId = await createExitCandidate("01D008AA", sessionId);
    await confirmExitCandidate(actor, undefined, candidateId, { paymentMethod: "cash" });
    const old = new Date(Date.now() - 20_000);
    await db("tb_exit_candidates").where({ id: candidateId }).update({ resolved_at: old, updated_at: old });
    await db("tb_parking_sessions").where({ id: sessionId }).update({ exited_at: old });
    await db("tb_activity_logs")
      .where({ target_type: "exit_candidate", target_id: candidateId })
      .whereIn("action", [
        "parking.exit_candidate_barrier_opened",
        "parking.exit_candidate_barrier_open_failed",
        "parking.exit_candidate_barrier_unavailable",
      ])
      .update({ created_at: old });
    const response = await getExitStatus();
    expect(response.body.state).toBe("idle");
  });

  it("9. entry event bo'lmasa idle qaytaradi", async () => {
    const response = await getEntryStatus();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: "idle", plate: null, barrier_status: null });
  });

  it("10. pending entry candidate awaiting_operator qaytaradi", async () => {
    await createEntryCandidate("01D010AA");
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({ state: "awaiting_operator", plate: "01D010AA" });
  });

  it("11. avtomatik entry session completed qaytaradi", async () => {
    const sessionId = await createActiveSession("01D011AA");
    await recordEntryBarrier(sessionId, "opened");
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({
      state: "completed",
      plate: "01D011AA",
      barrier_status: "opened",
    });
  });

  it("12. accepted entry candidate completed qaytaradi", async () => {
    const candidateId = await createEntryCandidate("01D012AA");
    await acceptEntryCandidate(actor, undefined, candidateId, { plateNumber: "01D012AA" });
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({
      state: "completed",
      plate: "01D012AA",
      barrier_status: "opened",
    });
  });

  it("13. declined entry candidate declined qaytaradi", async () => {
    const candidateId = await createEntryCandidate("01D013AA");
    await declineEntryCandidate(actor, undefined, candidateId, "Kiritilmadi");
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({ state: "declined", plate: "01D013AA" });
  });

  it("14. entry barrier failed holatini qaytaradi", async () => {
    const sessionId = await createActiveSession("01D014AA");
    await recordEntryBarrier(sessionId, "failed");
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({
      state: "barrier_failed",
      plate: "01D014AA",
      barrier_status: "failed",
    });
  });

  it.each(["disabled", "not_configured"] as const)(
    "entry HTTP barrier_status=%s bo'lsa barrier_failed qaytaradi",
    async (barrierStatus) => {
      const sessionId = await createActiveSession(`01E${barrierStatus === "disabled" ? "015" : "016"}AA`);
      await recordEntryBarrier(sessionId, barrierStatus);
      const response = await getEntryStatus();
      expect(response.body).toMatchObject({ state: "barrier_failed", barrier_status: barrierStatus });
    }
  );

  it.each(["disabled", "not_configured"] as const)(
    "exit HTTP barrier_status=%s bo'lsa barrier_failed qaytaradi",
    async (barrierStatus) => {
      openBarrierMock.mockResolvedValueOnce({ status: barrierStatus, success: false });
      const plate = `01X${barrierStatus === "disabled" ? "015" : "016"}AA`;
      const sessionId = await createActiveSession(plate);
      const candidateId = await createExitCandidate(plate, sessionId);
      await confirmExitCandidate(actor, undefined, candidateId, { paymentMethod: "cash" });
      const response = await getExitStatus();
      expect(response.body).toMatchObject({ state: "barrier_failed", barrier_status: barrierStatus });
    }
  );

  it("entry accept barrier_status=disabled bo'lsa barrier_failed qaytaradi", async () => {
    openBarrierMock.mockResolvedValueOnce({ status: "disabled", success: false });
    const candidateId = await createEntryCandidate("01E017AA");
    await acceptEntryCandidate(actor, undefined, candidateId, { plateNumber: "01E017AA" });
    const response = await getEntryStatus();
    expect(response.body).toMatchObject({ state: "barrier_failed", barrier_status: "disabled" });
  });

  it("17. report cash va online paymentlarni authoritative payment yozuvidan ajratadi", async () => {
    const cashSessionId = await createActiveSession("01D017CA");
    const cashCandidateId = await createExitCandidate("01D017CA", cashSessionId);
    await confirmExitCandidate(actor, undefined, cashCandidateId, { paymentMethod: "cash" });
    const onlineSessionId = await createActiveSession("01D017ON");
    const onlineCandidateId = await createExitCandidate("01D017ON", onlineSessionId);
    await confirmExitCandidate(actor, undefined, onlineCandidateId, { paymentMethod: "online" });
    const payments = await db("tb_payments")
      .select("payment_method", "amount")
      .whereIn("session_id", [cashSessionId, onlineSessionId]);
    const expectedCash = payments
      .filter((payment) => payment.payment_method === "cash")
      .reduce((sum, payment) => sum + Number(payment.amount), 0);
    const expectedOnline = payments
      .filter((payment) => payment.payment_method === "online")
      .reduce((sum, payment) => sum + Number(payment.amount), 0);
    const report = await getDailyReport(actor, undefined, undefined);
    expect(report.cash_revenue).toBe(expectedCash);
    expect(report.online_revenue).toBe(expectedOnline);
  });
});
