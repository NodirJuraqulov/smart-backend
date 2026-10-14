import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import { createExitCandidate } from "@/modules/exitCandidates/exitCandidates.service";
import parkingRouter from "@/modules/parking/parking.routes";
import cardTerminalSettingsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import {
  PaymentTerminalManager,
  paymentTerminalManager,
} from "@/modules/paymentTerminal/PaymentTerminalManager";
import type { PaymentTerminalLease } from "@/modules/paymentTerminal/PaymentTerminalManager";
import type { PaymentTerminal } from "@/modules/paymentTerminal/PaymentTerminal.interface";
import {
  createPaymentTerminalOperation,
  processCardPaymentOperation,
  runCardPaymentInBackground,
} from "@/modules/paymentTerminal/paymentTerminalOperations.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { telegramService } from "@/modules/telegram/telegram.service";
import {
  emitCardPaymentStarted,
  emitExitAwaitingPayment,
  emitExitCandidateResolved,
  emitExitCompleted,
  emitExitPaymentDeclined,
} from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestAwaitingPaymentSession,
  createTestOrganization,
  createTestUser,
  seedTestOperatorPermissions,
} from "./helpers";

const backgroundMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

const ledMocks = vi.hoisted(() => ({
  showPayment: vi.fn().mockResolvedValue(undefined),
  scheduleReturnToClock: vi.fn(),
}));

vi.mock("@/modules/paymentTerminal/paymentTerminalOperations.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/paymentTerminal/paymentTerminalOperations.service")>();
  return { ...actual, runCardPaymentInBackground: backgroundMocks.run };
});

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

vi.mock("@/modules/led/led.service", () => ({ ledService: ledMocks }));

vi.mock("@/modules/printer/printer.service", () => ({
  formatDuration: (minutes: number) => `${minutes} daqiqa`,
  printReceipt: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/modules/telegram/telegram.service", () => ({
  telegramService: { sendExitNotification: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/websocket/socketServer", () => ({
  emitCardPaymentStarted: vi.fn(),
  emitEntryDetected: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitPaymentDeclined: vi.fn(),
  emitParkingFull: vi.fn(),
  emitPublicExitStatusChanged: vi.fn(),
  emitRelayFailed: vi.fn(),
}));

let orgId: number;
let actor: AuthTokenPayload;
let terminal: PaymentTerminal;
let lease: PaymentTerminalLease;

const app = express();
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/parking", parkingRouter);
app.use("/api/organizations", cardTerminalSettingsRouter);
app.use(errorHandler);

function authorization(): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createCandidateSession(
  plateNumber: string,
  overrides: { sessionSource?: "regular" | "subscription" | "vip"; price?: number } = {}
) {
  const sessionId = await createTestActiveSession(
    orgId,
    plateNumber,
    new Date(Date.now() - 70 * 60 * 1000)
  );
  await db("tb_parking_sessions").where({ id: sessionId }).update({
    session_source: overrides.sessionSource ?? "regular",
    tariff_price_per_hour: overrides.price ?? 3000,
    tariff_grace_period_minutes: 0,
  });
  const [webhookEventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plateNumber,
    direction: "exit",
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: plateNumber,
    matched_session_id: sessionId,
    camera_event_at: new Date(),
    status: "pending",
  });
  return { sessionId, candidateId };
}

async function createExitWebhookEvent(plateNumber: string): Promise<number> {
  const [webhookEventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plateNumber,
    direction: "exit",
    camera_event_at: new Date(),
  });
  return webhookEventId;
}

async function enableTerminal(): Promise<void> {
  await db("tb_organizations").where({ id: orgId }).update({
    card_terminal_enabled: true,
    card_terminal_ip: "127.0.0.1",
    card_terminal_port: 62801,
  });
}

async function triggerAutomaticCardPayment(): Promise<request.Response> {
  await enableTerminal();
  return request(app)
    .get("/api/exit-candidates/next")
    .set("Authorization", authorization());
}

function approveTerminalPayment(operationNumber: string, amount = 6000): void {
  vi.mocked(terminal.startPayment).mockResolvedValue({
    status: "APPROVED",
    operationNumber,
    approvedAmountSom: amount,
    rawRequestHex: "aa",
    rawResponseHex: "bb",
    errorMessage: null,
  });
  vi.mocked(terminal.finalizePayment).mockResolvedValue({
    status: "FIN_CONFIRMED",
    rawRequestHex: "cc",
    rawResponseHex: "dd",
    errorMessage: null,
  });
}

function executeBackgroundCardPayments(): void {
  vi.mocked(terminal.startPayment).mockImplementation(async (operationNumber) => ({
    status: "DECLINED",
    operationNumber,
    approvedAmountSom: null,
    rawRequestHex: "aa",
    rawResponseHex: "bb",
    errorMessage: null,
  }));
  backgroundMocks.run.mockImplementation(
    (operationId: number, operationNumber: string, currentLease: PaymentTerminalLease) => {
      currentLease.bindOperation(operationNumber);
      setImmediate(() => {
        void processCardPaymentOperation(operationId, currentLease.terminal).finally(() => {
          currentLease.release();
        });
      });
    }
  );
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  env.exitMatchV2Enabled = false;
  backgroundMocks.run.mockReset();
  orgId = await createTestOrganization();
  await seedTestOperatorPermissions(orgId);
  const user = await createTestUser(orgId, { role: "operator" });
  actor = { id: user.id, org_id: orgId, role: "operator" };
  terminal = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    startPayment: vi.fn(),
    finalizePayment: vi.fn(),
    abortPendingPayment: vi.fn().mockResolvedValue(undefined),
  };
  lease = {
    terminal,
    bindOperation: vi.fn(),
    release: vi.fn(),
  };
  vi.spyOn(paymentTerminalManager, "acquireConfigured").mockReturnValue(lease);
  vi.spyOn(paymentTerminalManager, "acquire").mockResolvedValue(lease);
});

afterEach(async () => {
  env.exitMatchV2Enabled = false;
  await cleanupOrganization(orgId);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("Card payment oqimi", () => {
  it("createExitCandidate GET next'siz avtomatik VRP boshlaydi", async () => {
    await enableTerminal();
    executeBackgroundCardPayments();
    const plateNumber = "01C100AA";
    const sessionId = await createTestActiveSession(
      orgId,
      plateNumber,
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const webhookEventId = await createExitWebhookEvent(plateNumber);
    const result = await createExitCandidate({
      orgId,
      webhookEventId,
      detectedPlate: plateNumber,
      confidence: 99,
    });
    expect(result).toMatchObject({ created: true, coalesced: false });
    await vi.waitFor(() => {
      expect(terminal.startPayment).toHaveBeenCalledWith("1", 6000);
    });
    expect(emitCardPaymentStarted).toHaveBeenCalledWith(orgId, {
      sessionId,
      candidateId: result.candidateId,
      operationNumber: "1",
      plateNumber,
    });
    const operations = await db("payment_terminal_operations").where({ session_id: sessionId });
    expect(operations).toHaveLength(1);
  });

  it("V2 canonical distance=0 sessiya uchun avtomatik VRP boshlaydi", async () => {
    env.exitMatchV2Enabled = true;
    await enableTerminal();
    executeBackgroundCardPayments();
    const sessionId = await createTestActiveSession(
      orgId,
      "01O200BI",
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const webhookEventId = await createExitWebhookEvent("01020081");
    const result = await createExitCandidate({
      orgId,
      webhookEventId,
      detectedPlate: "01020081",
      confidence: 99,
    });
    expect(result).toMatchObject({ matchedSessionId: sessionId });
    await vi.waitFor(() => {
      expect(terminal.startPayment).toHaveBeenCalledWith("1", 6000);
    });
  });

  it("V2 distance=1 sessiya matched bo'lsa avtomatik VRP boshlamaydi", async () => {
    env.exitMatchV2Enabled = true;
    await enableTerminal();
    executeBackgroundCardPayments();
    const sessionId = await createTestActiveSession(
      orgId,
      "01C200AA",
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const webhookEventId = await createExitWebhookEvent("01C200AB");
    const result = await createExitCandidate({
      orgId,
      webhookEventId,
      detectedPlate: "01C200AB",
      confidence: 99,
    });
    expect(result).toMatchObject({ matchedSessionId: sessionId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminal.startPayment).not.toHaveBeenCalled();
    expect(await db("payment_terminal_operations").where({ session_id: sessionId })).toHaveLength(0);
  });

  it("flag o'chiq bo'lsa legacy distance=1 sessiya uchun avtomatik VRP boshlaydi", async () => {
    await enableTerminal();
    executeBackgroundCardPayments();
    const sessionId = await createTestActiveSession(
      orgId,
      "01C201AA",
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const webhookEventId = await createExitWebhookEvent("01C201AB");
    const result = await createExitCandidate({
      orgId,
      webhookEventId,
      detectedPlate: "01C201AB",
      confidence: 99,
    });
    expect(result).toMatchObject({ matchedSessionId: sessionId });
    await vi.waitFor(() => {
      expect(terminal.startPayment).toHaveBeenCalledWith("1", 6000);
    });
  });

  it("takroriy candidate signali coalesced bo'lganda faqat bitta operation yaratadi", async () => {
    await enableTerminal();
    executeBackgroundCardPayments();
    const plateNumber = "01C100AB";
    const sessionId = await createTestActiveSession(
      orgId,
      plateNumber,
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const firstEventId = await createExitWebhookEvent(plateNumber);
    const secondEventId = await createExitWebhookEvent(plateNumber);
    const first = await createExitCandidate({
      orgId,
      webhookEventId: firstEventId,
      detectedPlate: plateNumber,
      confidence: 99,
    });
    const second = await createExitCandidate({
      orgId,
      webhookEventId: secondEventId,
      detectedPlate: plateNumber,
      confidence: 98,
    });
    expect(first).toMatchObject({ created: true, coalesced: false });
    expect(second).toMatchObject({
      candidateId: first.candidateId,
      created: false,
      coalesced: true,
    });
    await vi.waitFor(async () => {
      expect(await db("payment_terminal_operations").where({ session_id: sessionId })).toHaveLength(1);
      expect(terminal.startPayment).toHaveBeenCalledTimes(1);
    });
  });

  it("create paytida session noma'lum bo'lsa kutadi va keyingi GET next fallback trigger qiladi", async () => {
    await enableTerminal();
    executeBackgroundCardPayments();
    const plateNumber = "01C100AC";
    const webhookEventId = await createExitWebhookEvent(plateNumber);
    const created = await createExitCandidate({
      orgId,
      webhookEventId,
      detectedPlate: plateNumber,
      confidence: 99,
    });
    expect(created).toMatchObject({ created: true, coalesced: false });
    if (created.skipped) throw new Error("Candidate yaratilishi kutilgan edi");
    expect(created.candidate.matched_session_id).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminal.startPayment).not.toHaveBeenCalled();
    expect(await db("payment_terminal_operations").where({ candidate_id: created.candidateId })).toHaveLength(0);
    const sessionId = await createTestActiveSession(
      orgId,
      plateNumber,
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const response = await request(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(response.body.matched_session.session_id).toBe(sessionId);
    await vi.waitFor(() => {
      expect(terminal.startPayment).toHaveBeenCalledWith("1", 6000);
    });
  });

  it("candidate ko'rsatilganda terminal yoqilgan va summa musbat bo'lsa avtomatik VRP yaratadi", async () => {
    const { sessionId, candidateId } = await createCandidateSession("01C101AA");
    const response = await triggerAutomaticCardPayment();
    expect(response.status).toBe(200);
    const [session, candidate, operation, payments] = await Promise.all([
      db("tb_parking_sessions").where({ id: sessionId }).first(),
      db("tb_exit_candidates").where({ id: candidateId }).first(),
      db("payment_terminal_operations").where({ session_id: sessionId }).first(),
      db("tb_payments").where({ session_id: sessionId }),
    ]);
    expect(session.status).toBe("active");
    expect(candidate).toMatchObject({ status: "pending", resolution_type: null });
    expect(operation).toMatchObject({
      status: "PENDING",
      candidate_id: candidateId,
      operator_id: null,
    });
    expect(payments).toHaveLength(0);
    expect(runCardPaymentInBackground).toHaveBeenCalledWith(operation.id, "1", lease);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    expect(emitExitCandidateResolved).not.toHaveBeenCalled();
    expect(emitExitCompleted).not.toHaveBeenCalled();
  });

  it("regular bo'lmagan sessiya uchun avtomatik VRP boshlamaydi", async () => {
    const { sessionId } = await createCandidateSession("01C102AA", { sessionSource: "vip" });
    await triggerAutomaticCardPayment();
    expect(await db("payment_terminal_operations").where({ session_id: sessionId })).toHaveLength(0);
    expect(runCardPaymentInBackground).not.toHaveBeenCalled();
  });

  it("summa nol bo'lsa avtomatik VRP boshlamaydi", async () => {
    const { sessionId } = await createCandidateSession("01C103AA", { price: 0 });
    await triggerAutomaticCardPayment();
    expect(await db("payment_terminal_operations").where({ session_id: sessionId })).toHaveLength(0);
    expect(runCardPaymentInBackground).not.toHaveBeenCalled();
  });

  it("terminal band bo'lsa xatosiz chiqadi va yangi VRP yaratmaydi", async () => {
    const { sessionId } = await createCandidateSession("01C104AA");
    await enableTerminal();
    vi.spyOn(paymentTerminalManager, "isBusy").mockReturnValue(true);
    const response = await request(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(await db("payment_terminal_operations").where({ session_id: sessionId })).toHaveLength(0);
    expect(emitCardPaymentStarted).not.toHaveBeenCalled();
  });

  it("FIN_CONFIRMED active va pending candidate'ni card bilan bir marta yakunlaydi", async () => {
    const { sessionId, candidateId } = await createCandidateSession("01C105AA");
    await triggerAutomaticCardPayment();
    const operation = await db("payment_terminal_operations").where({ session_id: sessionId }).first();
    approveTerminalPayment(operation.operation_number);
    await processCardPaymentOperation(operation.id, terminal);
    const [session, candidate, payment, completedOperation] = await Promise.all([
      db("tb_parking_sessions").where({ id: sessionId }).first(),
      db("tb_exit_candidates").where({ id: candidateId }).first(),
      db("tb_payments").where({ session_id: sessionId }).first(),
      db("payment_terminal_operations").where({ id: operation.id }).first(),
    ]);
    expect(session).toMatchObject({ status: "completed", payment_method: "card" });
    expect(candidate).toMatchObject({ status: "accepted", resolution_type: "exact" });
    expect(Number(session.amount)).toBe(6000);
    expect(payment.payment_method).toBe("card");
    expect(Number(payment.amount)).toBe(6000);
    expect(completedOperation.status).toBe("FIN_CONFIRMED");
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ sessionId, paymentMethod: "card", amount: 6000 })
    );
    expect(emitExitCandidateResolved).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ candidateId, resolutionType: "exact" })
    );
    expect(ledMocks.showPayment).toHaveBeenCalledWith(orgId, "01C105AA", 6000);
    await vi.waitFor(() => {
      expect(telegramService.sendExitNotification).toHaveBeenCalledWith(
        orgId,
        expect.objectContaining({ plateNumber: "01C105AA", paymentMethod: "card", amount: 6000 })
      );
    });
  });

  it("FIN_CONFIRMED kelganda sessiya oldin yopilgan bo'lsa STALE_IGNORED qiladi", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sessionId, candidateId } = await createCandidateSession("01C106AA");
    await triggerAutomaticCardPayment();
    const operation = await db("payment_terminal_operations").where({ session_id: sessionId }).first();
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      payment_method: "cash",
      active_plate_key: null,
    });
    await db("tb_exit_candidates").where({ id: candidateId }).update({
      status: "accepted",
      resolution_type: "exact",
    });
    approveTerminalPayment(operation.operation_number);
    await processCardPaymentOperation(operation.id, terminal);
    const [session, candidate, payments, staleOperation] = await Promise.all([
      db("tb_parking_sessions").where({ id: sessionId }).first(),
      db("tb_exit_candidates").where({ id: candidateId }).first(),
      db("tb_payments").where({ session_id: sessionId }),
      db("payment_terminal_operations").where({ id: operation.id }).first(),
    ]);
    expect(session).toMatchObject({ status: "completed", payment_method: "cash" });
    expect(candidate).toMatchObject({ status: "accepted", resolution_type: "exact" });
    expect(payments).toHaveLength(0);
    expect(staleOperation.status).toBe("STALE_IGNORED");
    expect(openBarrier).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("STALE CARD PAYMENT"));
  });

  it("confirm endpoint card qiymatini 400 bilan rad etadi", async () => {
    const { sessionId, candidateId } = await createCandidateSession("01C107AA");
    const response = await request(app)
      .post(`/api/exit-candidates/${candidateId}/confirm`)
      .set("Authorization", authorization())
      .send({ payment_method: "card" });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("cash");
    expect((await db("tb_parking_sessions").where({ id: sessionId }).first()).status).toBe("active");
    expect((await db("tb_exit_candidates").where({ id: candidateId }).first()).status).toBe("pending");
  });

  it("manual exit card tanlanganda sessiyani active qoldirib background VRP boshlaydi", async () => {
    const sessionId = await createTestActiveSession(
      orgId,
      "01C108AA",
      new Date(Date.now() - 70 * 60 * 1000)
    );
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      tariff_price_per_hour: 3000,
      tariff_grace_period_minutes: 0,
    });
    const response = await request(app)
      .post("/api/parking/exit/manual")
      .set("Authorization", authorization())
      .send({ plate_number: "01C108AA", payment_method: "card" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      session: { id: sessionId, status: "active" },
      payment: null,
      barrier_status: null,
      operation_number: "1",
    });
    const operation = await db("payment_terminal_operations").where({ session_id: sessionId }).first();
    expect(operation.candidate_id).toBeNull();
    expect(runCardPaymentInBackground).toHaveBeenCalledWith(operation.id, "1", lease);
    expect(emitCardPaymentStarted).toHaveBeenCalledWith(orgId, {
      sessionId,
      candidateId: null,
      operationNumber: "1",
      plateNumber: "01C108AA",
    });
    expect(openBarrier).not.toHaveBeenCalled();
    approveTerminalPayment(operation.operation_number);
    await processCardPaymentOperation(operation.id, terminal);
    expect((await db("tb_parking_sessions").where({ id: sessionId }).first()).status).toBe("completed");
    expect((await db("tb_payments").where({ session_id: sessionId }).first()).payment_method).toBe(
      "card"
    );
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
  });

  it.each(["cash", "online"] as const)(
    "candidate %s bilan yopilganda faol card operatsiyasini ABORTED qiladi",
    async (paymentMethod) => {
      const plateNumber = paymentMethod === "cash" ? "01C109AA" : "01C109AB";
      const { sessionId, candidateId } = await createCandidateSession(plateNumber);
      await triggerAutomaticCardPayment();
      const abort = vi.spyOn(paymentTerminalManager, "abortPendingPayment").mockResolvedValue(undefined);
      const response = await request(app)
        .post(`/api/exit-candidates/${candidateId}/confirm`)
        .set("Authorization", authorization())
        .send({ payment_method: paymentMethod });
      expect(response.status).toBe(200);
      await vi.waitFor(async () => {
        expect(
          (await db("payment_terminal_operations").where({ session_id: sessionId }).first()).status
        ).toBe("ABORTED");
      });
      expect(abort).toHaveBeenCalledWith(orgId, "1");
    }
  );

  it("confirmCashPayment faol card operatsiyasini ABORTED qiladi", async () => {
    const sessionId = await createTestAwaitingPaymentSession(orgId, "01C110AA");
    const pendingOperation = await db.transaction((trx) =>
      createPaymentTerminalOperation(trx, {
        orgId,
        sessionId,
        candidateId: null,
        operatorId: actor.id,
        amountSom: 3000,
      })
    );
    const abort = vi.spyOn(paymentTerminalManager, "abortPendingPayment").mockResolvedValue(undefined);
    const response = await request(app)
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authorization());
    expect(response.status).toBe(200);
    await vi.waitFor(async () => {
      expect(
        (await db("payment_terminal_operations").where({ id: pendingOperation.id }).first()).status
      ).toBe("ABORTED");
    });
    expect(abort).toHaveBeenCalledWith(orgId, pendingOperation.operationNumber);
  });

  it("retry faqat active sessiya va oxirgi DECLINED operatsiyadan keyin yangi raqam yaratadi", async () => {
    const { sessionId } = await createCandidateSession("01C111AA");
    await triggerAutomaticCardPayment();
    await db("payment_terminal_operations").where({ session_id: sessionId }).update({ status: "DECLINED" });
    const response = await request(app)
      .post(`/api/parking/sessions/${sessionId}/retry-card-payment`)
      .set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      session_id: sessionId,
      status: "active",
      operation_number: "2",
    });
    const operations = await db("payment_terminal_operations")
      .where({ session_id: sessionId })
      .orderBy("id", "asc");
    expect(operations.map((row) => row.operation_number)).toEqual(["1", "2"]);
  });

  it("retry yopilgan sessiyani 409 bilan rad etadi", async () => {
    const { sessionId } = await createCandidateSession("01C112AA");
    await triggerAutomaticCardPayment();
    await db("payment_terminal_operations").where({ session_id: sessionId }).update({ status: "DECLINED" });
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      active_plate_key: null,
    });
    const response = await request(app)
      .post(`/api/parking/sessions/${sessionId}/retry-card-payment`)
      .set("Authorization", authorization());
    expect(response.status).toBe(409);
    expect(response.body.message).toBe("Sessiya allaqachon yopilgan");
  });

  it("startup ikki daqiqadan eski PENDING va APPROVED operatsiyalarni ORPHANED qiladi", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionId = await createTestActiveSession(orgId, "01C113AA");
    const pendingOperation = await db.transaction((trx) =>
      createPaymentTerminalOperation(trx, {
        orgId,
        sessionId,
        candidateId: null,
        operatorId: actor.id,
        amountSom: 3000,
      })
    );
    const approvedOperation = await db.transaction((trx) =>
      createPaymentTerminalOperation(trx, {
        orgId,
        sessionId,
        candidateId: null,
        operatorId: actor.id,
        amountSom: 3000,
      })
    );
    await db("payment_terminal_operations")
      .whereIn("id", [pendingOperation.id, approvedOperation.id])
      .update({ created_at: new Date(Date.now() - 3 * 60_000) });
    await db("payment_terminal_operations")
      .where({ id: approvedOperation.id })
      .update({ status: "APPROVED", approved_amount_som: 3000 });
    await enableTerminal();
    const factory = vi.fn(() => terminal);
    const manager = new PaymentTerminalManager(factory);
    await manager.start();
    const orphaned = await db("payment_terminal_operations")
      .whereIn("id", [pendingOperation.id, approvedOperation.id])
      .orderBy("id", "asc");
    expect(orphaned.map((operation) => operation.status)).toEqual(["ORPHANED", "ORPHANED"]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("ORPHANED CARD OPERATION"));
    await manager.stop();
  });

  it("DECLINED sessiya va candidate holatini o'zgartirmaydi va websocket yuboradi", async () => {
    const { sessionId, candidateId } = await createCandidateSession("01C114AA");
    await triggerAutomaticCardPayment();
    const operation = await db("payment_terminal_operations").where({ session_id: sessionId }).first();
    vi.mocked(terminal.startPayment).mockResolvedValue({
      status: "DECLINED",
      operationNumber: operation.operation_number,
      approvedAmountSom: null,
      rawRequestHex: "aa",
      rawResponseHex: "bb",
      errorMessage: null,
    });
    await processCardPaymentOperation(operation.id, terminal);
    expect((await db("tb_parking_sessions").where({ id: sessionId }).first()).status).toBe("active");
    expect((await db("tb_exit_candidates").where({ id: candidateId }).first()).status).toBe("pending");
    expect(emitExitPaymentDeclined).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ sessionId, reason: "declined" })
    );
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("FIN uch marta muvaffaqiyatsiz bo'lsa active sessiyani ochmaydi", async () => {
    const { sessionId } = await createCandidateSession("01C115AA");
    await triggerAutomaticCardPayment();
    const operation = await db("payment_terminal_operations").where({ session_id: sessionId }).first();
    approveTerminalPayment(operation.operation_number);
    vi.mocked(terminal.finalizePayment).mockResolvedValue({
      status: "FIN_FAILED",
      rawRequestHex: "cc",
      rawResponseHex: "ee",
      errorMessage: "FIN mos emas",
    });
    await processCardPaymentOperation(operation.id, terminal, async () => undefined);
    expect(terminal.finalizePayment).toHaveBeenCalledTimes(3);
    expect((await db("tb_parking_sessions").where({ id: sessionId }).first()).status).toBe("active");
    expect((await db("payment_terminal_operations").where({ id: operation.id }).first()).status).toBe(
      "FIN_FAILED"
    );
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("concurrent yaratishda operation number takrorlanmaydi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01C116AA");
    const created = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.transaction((trx) =>
          createPaymentTerminalOperation(trx, {
            orgId,
            sessionId,
            candidateId: null,
            operatorId: actor.id,
            amountSom: 1000,
          })
        )
      )
    );
    expect(new Set(created.map((item) => item.operationNumber)).size).toBe(5);
    expect(created.map((item) => Number(item.operationNumber)).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("disabled filialni manager ishga tushirganda socket instance yaratmaydi", async () => {
    const factory = vi.fn<() => PaymentTerminal>();
    const manager = new PaymentTerminalManager(factory);
    await manager.start();
    expect(factory).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("manager bir terminal uchun bitta lease beradi va operationni bog'laydi", () => {
    const factory = vi.fn(() => terminal);
    const manager = new PaymentTerminalManager(factory);
    const settings = {
      id: orgId,
      card_terminal_enabled: true,
      card_terminal_ip: "127.0.0.1",
      card_terminal_port: 62801,
    };
    const first = manager.acquireConfigured(settings);
    first.bindOperation("1");
    expect(() => manager.acquireConfigured(settings)).toThrow("Terminal band");
    first.release();
    const second = manager.acquireConfigured(settings);
    expect(second.terminal).toBe(terminal);
    second.release();
  });

  it("manager abortdan keyin terminal bandligini bo'shatadi", async () => {
    const factory = vi.fn(() => terminal);
    const manager = new PaymentTerminalManager(factory);
    const settings = {
      id: orgId,
      card_terminal_enabled: true,
      card_terminal_ip: "127.0.0.1",
      card_terminal_port: 62801,
    };
    const first = manager.acquireConfigured(settings);
    first.bindOperation("1");
    await manager.abortPendingPayment(orgId, "1");
    expect(terminal.abortPendingPayment).toHaveBeenCalledWith("1");
    expect(manager.isBusy(orgId)).toBe(false);
    manager.acquireConfigured(settings).release();
    await manager.stop();
  });

  it("Owner terminalning to'liq sozlamalarini ko'radi", async () => {
    const owner = await createTestUser(orgId, { role: "owner" });
    const ownerActor: AuthTokenPayload = { id: owner.id, org_id: orgId, role: "owner" };
    await db("tb_organizations").where({ id: orgId }).update({
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.55",
      card_terminal_port: 62801,
      card_terminal_id: "VTK-01",
      card_terminal_merchant_id: "MERCHANT-01",
      card_terminal_keepalive_interval_seconds: 600,
    });
    const response = await request(app)
      .get(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", `Bearer ${signAccessToken(ownerActor)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: orgId,
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.55",
      card_terminal_port: 62801,
      card_terminal_id: "VTK-01",
      card_terminal_merchant_id: "MERCHANT-01",
      card_terminal_keepalive_interval_seconds: 600,
    });
  });

  it("Super Admin terminalning to'liq sozlamalarini ko'radi", async () => {
    const superAdmin = await createTestUser(null, { role: "super_admin" });
    const superActor: AuthTokenPayload = { id: superAdmin.id, org_id: null, role: "super_admin" };
    await db("tb_organizations").where({ id: orgId }).update({
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.56",
      card_terminal_port: 62802,
      card_terminal_id: "VTK-02",
      card_terminal_merchant_id: "MERCHANT-02",
      card_terminal_keepalive_interval_seconds: 300,
    });
    const response = await request(app)
      .get(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", `Bearer ${signAccessToken(superActor)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: orgId,
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.56",
      card_terminal_port: 62802,
      card_terminal_id: "VTK-02",
      card_terminal_merchant_id: "MERCHANT-02",
      card_terminal_keepalive_interval_seconds: 300,
    });
    await db("tb_users").where({ id: superAdmin.id }).del();
  });

  it("Operator faqat terminal yoqilgan yoki o'chirilganini ko'radi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.57",
      card_terminal_port: 62803,
      card_terminal_id: "VTK-03",
      card_terminal_merchant_id: "MERCHANT-03",
      card_terminal_keepalive_interval_seconds: 120,
    });
    const response = await request(app)
      .get(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", authorization());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ card_terminal_enabled: true });
  });

  it("Operator boshqa tashkilotning terminal holatini ko'ra olmaydi", async () => {
    const otherOrgId = await createTestOrganization();
    try {
      const response = await request(app)
        .get(`/api/organizations/${otherOrgId}/card-terminal-settings`)
        .set("Authorization", authorization());
      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Stoyanka topilmadi");
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });

  it("PATCH terminal sozlamalari faqat Super Admin uchun qoladi", async () => {
    const operatorResponse = await request(app)
      .patch(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", authorization())
      .send({ card_terminal_enabled: false });
    expect(operatorResponse.status).toBe(403);
    const owner = await createTestUser(orgId, { role: "owner" });
    const ownerActor: AuthTokenPayload = { id: owner.id, org_id: orgId, role: "owner" };
    const ownerResponse = await request(app)
      .patch(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", `Bearer ${signAccessToken(ownerActor)}`)
      .send({ card_terminal_enabled: false });
    expect(ownerResponse.status).toBe(403);
    const superAdmin = await createTestUser(null, { role: "super_admin" });
    const superActor: AuthTokenPayload = { id: superAdmin.id, org_id: null, role: "super_admin" };
    const reload = vi.spyOn(paymentTerminalManager, "reloadTerminal").mockResolvedValue(undefined);
    const updateResponse = await request(app)
      .patch(`/api/organizations/${orgId}/card-terminal-settings`)
      .set("Authorization", `Bearer ${signAccessToken(superActor)}`)
      .send({
        card_terminal_enabled: true,
        card_terminal_ip: "192.168.1.55",
        card_terminal_port: 62801,
        card_terminal_id: "VTK-01",
        card_terminal_merchant_id: "MERCHANT-01",
      });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body).toMatchObject({
      card_terminal_enabled: true,
      card_terminal_ip: "192.168.1.55",
      card_terminal_port: 62801,
      card_terminal_id: "VTK-01",
      card_terminal_merchant_id: "MERCHANT-01",
    });
    expect(reload).toHaveBeenCalledWith(orgId);
    await db("tb_users").where({ id: superAdmin.id }).del();
  });
});
