import { promises as fs } from "fs";
import path from "path";
import express from "express";
import type { Knex } from "knex";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { openBarrier } from "@/modules/relay/relay.service";
import { getSessionById } from "@/modules/parking/parking.service";
import {
  emitExitCandidateCreated,
  emitExitCandidateResolved,
  emitExitCompleted,
} from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

const ledMocks = vi.hoisted(() => ({
  showPayment: vi.fn<(orgId: number, plate: string, amount: number) => Promise<void>>(),
  showPlateOnly: vi.fn<(orgId: number, plate: string) => Promise<void>>(),
  scheduleReturnToClock: vi.fn<(orgId: number) => void>(),
}));

vi.mock("@/modules/relay/relay.service", () => {
  const createMock = vi.fn as unknown as () => ReturnType<typeof vi.fn>;
  return { openBarrier: createMock() };
});

vi.mock("@/modules/led/led.service", () => ({
  ledService: ledMocks,
}));

vi.mock("@/websocket/socketServer", () => {
  const createMock = vi.fn as unknown as () => ReturnType<typeof vi.fn>;
  return {
    emitEntryDetected: createMock(),
    emitEntryBarrierFailed: createMock(),
    emitEntryCandidateCreated: createMock(),
    emitEntryCandidateResolved: createMock(),
    emitEntryCompleted: createMock(),
    emitParkingFull: createMock(),
    emitExitAwaitingPayment: createMock(),
    emitExitCompleted: createMock(),
    emitExitCandidateCreated: createMock(),
    emitExitCandidateResolved: createMock(),
    emitPlateNotRecognizedForExit: createMock(),
    emitPublicEntryStatusChanged: createMock(),
    emitPublicExitStatusChanged: createMock(),
    emitRelayFailed: createMock(),
    emitWebhookParseFailed: createMock(),
  };
});

let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let otherActor: AuthTokenPayload;
let authorizationHeader: string;
let otherAuthorizationHeader: string;
let jpegBase64: string;

interface TestCandidateRow {
  id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  matched_session_id: number | null;
  status: string;
}

interface ActivityLogRow {
  details: Record<string, unknown>;
}

interface CompletionSessionRow {
  status: string;
  amount: number | string;
  payment_method: string | null;
  exited_at?: Date | string | null;
  active_plate_key?: string | null;
}

interface CandidateStateRow {
  status: string;
  resolution_type: string | null;
  resolved_session_id: number | null;
}

interface PaymentRow {
  amount: number | string;
  payment_method: string;
}

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

function dahuaPayload(
  plate: string | null,
  confidence = 91,
  snapTime = DateTime.now()
) {
  return {
    Picture: {
      NormalPic: { Content: jpegBase64, PicName: "overview.jpg" },
      PlatePic: { Content: jpegBase64, PicName: "plate.jpg" },
    },
    Plate: { IsExist: plate !== null, PlateNumber: plate ?? "", Confidence: confidence },
    Vehicle: { VehicleBoundingBox: { Left: 10, Top: 5, Right: 90, Bottom: 55 } },
    SnapInfo: {
      DeviceID: "candidate-camera",
      SnapTime: snapTime.toFormat("yyyy-MM-dd HH:mm:ss"),
    },
  };
}

async function postExit(
  plate: string | null,
  confidence = 91,
  snapTime = DateTime.now()
): Promise<request.Response> {
  return request(app)
    .post(`/api/webhook/camera/${webhookToken}/exit`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plate, confidence, snapTime));
}

async function createSession(
  plate: string,
  source: "regular" | "vip" | "subscription" = "regular",
  ownerOrgId = orgId,
  pricePerHour = 5000
): Promise<number> {
  const id = await createTestActiveSession(ownerOrgId, plate, new Date(Date.now() - 61 * 60_000));
  await db("tb_parking_sessions").where({ id }).update({
    session_source: source,
    tariff_price_per_hour: source === "regular" ? pricePerHour : null,
    tariff_grace_period_minutes: source === "regular" ? 0 : null,
    tariff_intervals_snapshot: null,
  });
  return id;
}

async function candidateForPlate(plate: string): Promise<TestCandidateRow> {
  const candidate = await queryTable<TestCandidateRow>("tb_exit_candidates")
    .where({ org_id: orgId, detected_plate: plate })
    .orderBy("id", "desc")
    .first();
  if (!candidate) throw new Error(`Candidate topilmadi: ${plate}`);
  return candidate;
}

async function confirm(
  candidateId: number,
  body: Record<string, unknown>,
  authorization = authorizationHeader
): Promise<request.Response> {
  return request(app)
    .post(`/api/exit-candidates/${candidateId}/confirm`)
    .set("Authorization", authorization)
    .send(body);
}

async function createOwnerActor(ownerOrgId: number): Promise<AuthTokenPayload> {
  const user = await createTestUser(ownerOrgId, { role: "owner" });
  return { id: user.id, org_id: ownerOrgId, role: "owner" };
}

async function createJpegBase64(): Promise<string> {
  const image = sharp({ create: { width: 100, height: 60, channels: 3, background: "#555" } });
  const buffer: Buffer = await image.jpeg().toBuffer();
  return buffer.toString("base64");
}

function queryTable<TRow extends object = Record<string, unknown>>(
  tableName: string
): Knex.QueryBuilder<Record<string, unknown>, TRow[]> {
  return db(tableName) as Knex.QueryBuilder<Record<string, unknown>, TRow[]>;
}
const testRequest: typeof request = request;
const openBarrierMock = openBarrier as unknown as ReturnType<typeof vi.fn>;
const exitCandidateCreatedMock = emitExitCandidateCreated as unknown as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = await createJpegBase64();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `candidate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestTariff(otherOrgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  actor = await createOwnerActor(orgId);
  otherActor = await createOwnerActor(otherOrgId);
  authorizationHeader = `Bearer ${signAccessToken(actor)}`;
  otherAuthorizationHeader = `Bearer ${signAccessToken(otherActor)}`;
  openBarrierMock.mockReset();
  openBarrierMock.mockResolvedValue({ status: "opened", success: true });
  vi.clearAllMocks();
  ledMocks.showPayment.mockReset().mockResolvedValue(undefined);
  ledMocks.showPlateOnly.mockReset().mockResolvedValue(undefined);
  ledMocks.scheduleReturnToClock.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearWebhookDedupeCache(orgId);
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("exit candidate completion workflow", () => {
  it("yangi exit candidate yaratilgandan keyin LED plate yuboriladi", async () => {
    let releasePlate = (): void => undefined;
    ledMocks.showPlateOnly.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePlate = resolve;
        })
    );
    const response = await postExit("01W100AA");
    expect(response.status).toBe(200);
    expect(ledMocks.showPlateOnly).toHaveBeenCalledWith(orgId, "01W100AA");
    expect(exitCandidateCreatedMock.mock.invocationCallOrder[0]).toBeLessThan(
      ledMocks.showPlateOnly.mock.invocationCallOrder[0]
    );
    expect(await candidateForPlate("01W100AA")).toBeDefined();
    releasePlate();
  });

  it("exit webhook plate topmasa LEDga hech narsa yubormaydi", async () => {
    const response = await postExit(null);
    expect(response.status).toBe(200);
    expect(ledMocks.showPlateOnly).not.toHaveBeenCalled();
    expect(ledMocks.showPayment).not.toHaveBeenCalled();
  });

  it("same-direction duplicate webhook LEDga qayta signal yubormaydi", async () => {
    const first = await postExit("01W101AA");
    expect(first.status).toBe(200);
    ledMocks.showPlateOnly.mockClear();
    ledMocks.showPayment.mockClear();

    const second = await postExit("01W101AA");

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect(ledMocks.showPlateOnly).not.toHaveBeenCalled();
    expect(ledMocks.showPayment).not.toHaveBeenCalled();
  });

  it("1. exact regular cash completed, payment va next response to'g'ri", async () => {
    const sessionId = await createSession("01A100AA");
    await postExit("01A100AA");
    const candidate = await candidateForPlate("01A100AA");
    expect(emitExitCandidateCreated).toHaveBeenCalledTimes(1);
    const createdCall = exitCandidateCreatedMock.mock.calls[0];
    if (!createdCall) throw new Error("Exit candidate socket eventi yuborilmadi");
    expect(createdCall[0]).toBe(orgId);
    expect(createdCall[1]).toMatchObject({
      candidateId: candidate.id,
      orgId,
      webhookEventId: candidate.webhook_event_id,
      detectedPlate: "01A100AA",
      matchedSessionId: sessionId,
      confidence: 91,
      status: "pending",
    });
    const createdPayload = createdCall[1];
    expect(typeof createdPayload.cameraEventAt).toBe("string");
    expect(typeof createdPayload.exitImages.overviewUrl).toBe("string");
    expect(typeof createdPayload.exitImages.vehicleUrl).toBe("string");
    expect(typeof createdPayload.exitImages.plateUrl).toBe("string");
    const next = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorizationHeader);
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({
      candidate_id: candidate.id,
      status: "pending",
      detected_plate: "01A100AA",
      exit_images: { vehicle_url: null, image_available: true },
      matched_session: {
        session_id: sessionId,
        plate_number: "01A100AA",
        session_source: "regular",
        entry_images: { overview_url: null, vehicle_url: null, image_available: false },
        tariff_snapshot_amount: 10000,
      },
      pending_count_for_org: 1,
    });
    expect(typeof next.body.exit_images.overview_url).toBe("string");
    const response = await confirm(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({
      status: "completed",
      payment_method: "cash",
      active_plate_key: null,
    });
    const payment = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    if (!payment) throw new Error("Payment topilmadi");
    expect(payment).toMatchObject({ payment_method: "cash" });
    expect(Number(payment.amount)).toBe(10000);
    expect(ledMocks.showPayment).toHaveBeenCalledWith(orgId, "01A100AA", 10000);
    expect(ledMocks.scheduleReturnToClock).toHaveBeenCalledWith(orgId);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        orgId,
        sessionId,
        plateNumber: "01A100AA",
        amount: 10000,
        paymentMethod: "cash",
        barrierStatus: "opened",
      })
    );
    expect(emitExitCandidateResolved).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        candidateId: candidate.id,
        orgId,
        status: "accepted",
        resolutionType: "exact",
        sessionId,
        barrierStatus: "opened",
      })
    );
  });

  it("preview-session summani hisoblaydi va LEDni kutmasdan javob qaytaradi", async () => {
    const sessionId = await createSession("01L100AA");
    await postExit("WRONGP1");
    const candidate = await candidateForPlate("WRONGP1");
    ledMocks.showPayment.mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/preview-session`)
      .set("Authorization", authorizationHeader)
      .send({ sessionId });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ plateNumber: "01L100AA", amount: 10000 });
    expect(ledMocks.showPayment).toHaveBeenCalledWith(orgId, "01L100AA", 10000);
    expect(ledMocks.scheduleReturnToClock).not.toHaveBeenCalled();
  });

  it("preview-session boshqa organization sessiyasini ko'rsatmaydi", async () => {
    const foreignSessionId = await createSession("01L101AA", "regular", otherOrgId);
    await postExit("WRONGP2");
    const candidate = await candidateForPlate("WRONGP2");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/preview-session`)
      .set("Authorization", authorizationHeader)
      .send({ sessionId: foreignSessionId });
    expect(response.status).toBe(404);
    expect(ledMocks.showPayment).not.toHaveBeenCalled();
  });

  it("next candidate LEDni darhol bir marta yuboradi va pollingda takrorlamaydi", async () => {
    await createSession("01L102AA");
    await postExit("01L102AA");
    ledMocks.showPayment.mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const first = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorizationHeader);
    expect(first.status).toBe(200);
    expect(ledMocks.showPayment).toHaveBeenCalledWith(orgId, "01L102AA", 10000);
    const second = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorizationHeader);
    expect(second.status).toBe(200);
    expect(ledMocks.showPayment).toHaveBeenCalledTimes(1);
    expect(ledMocks.scheduleReturnToClock).not.toHaveBeenCalled();
  });

  it("force-open faqat plate yuboradi va LEDni kutmaydi", async () => {
    await postExit("UNKNOWNP3");
    const candidate = await candidateForPlate("UNKNOWNP3");
    ledMocks.showPlateOnly.mockClear();
    ledMocks.showPlateOnly.mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader);
    expect(response.status).toBe(200);
    expect(ledMocks.showPlateOnly).toHaveBeenCalledWith(orgId, "UNKNOWNP3");
    expect(ledMocks.showPayment).not.toHaveBeenCalled();
    expect(ledMocks.scheduleReturnToClock).toHaveBeenCalledWith(orgId);
    expect(ledMocks.showPlateOnly.mock.invocationCallOrder[0]).toBeLessThan(
      ledMocks.scheduleReturnToClock.mock.invocationCallOrder[0]
    );
    expect(ledMocks.scheduleReturnToClock.mock.invocationCallOrder[0]).toBeLessThan(
      openBarrierMock.mock.invocationCallOrder[0]
    );
  });

  it("LED xatosi next, preview-session va force-open oqimlarini to'xtatmaydi", async () => {
    const sessionId = await createSession("01L103AA");
    await postExit("01L103AA");
    const candidate = await candidateForPlate("01L103AA");
    const paymentError = new Error("LED payment failed");
    const plateError = new Error("LED plate failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ledMocks.showPayment.mockRejectedValueOnce(paymentError);
    const next = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorizationHeader);
    expect(next.status).toBe(200);
    ledMocks.showPayment.mockRejectedValueOnce(paymentError);
    const preview = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/preview-session`)
      .set("Authorization", authorizationHeader)
      .send({ sessionId });
    expect(preview.status).toBe(200);
    await postExit("UNKNOWNP4");
    const forceCandidate = await candidateForPlate("UNKNOWNP4");
    ledMocks.showPlateOnly.mockRejectedValueOnce(plateError);
    const force = await testRequest(app)
      .post(`/api/exit-candidates/${forceCandidate.id}/force-open`)
      .set("Authorization", authorizationHeader);
    expect(force.status).toBe(200);
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("LED_PAYMENT_FAILED", paymentError);
      expect(consoleError).toHaveBeenCalledWith("LED_PLATE_FAILED", plateError);
    });
  });

  it("LED sekin barrier tugashidan oldin boshlanadi", async () => {
    await createSession("01P100AA");
    await postExit("01P100AA");
    const candidate = await candidateForPlate("01P100AA");
    let resolveBarrier = (): void => {
      throw new Error("Sekin barrier resolver topilmadi");
    };
    let barrierResolved = false;
    openBarrierMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBarrier = () => {
            barrierResolved = true;
            resolve({ status: "opened", success: true });
          };
        })
    );
    const confirmation = confirm(candidate.id, { payment_method: "cash" });
    await vi.waitFor(() => {
      expect(ledMocks.showPayment).toHaveBeenCalledTimes(1);
      expect(ledMocks.scheduleReturnToClock).toHaveBeenCalledTimes(1);
      expect(openBarrier).toHaveBeenCalledTimes(1);
    });
    expect(barrierResolved).toBe(false);
    expect(ledMocks.showPayment.mock.invocationCallOrder[0]).toBeLessThan(
      openBarrierMock.mock.invocationCallOrder[0]
    );
    expect(ledMocks.scheduleReturnToClock.mock.invocationCallOrder[0]).toBeLessThan(
      openBarrierMock.mock.invocationCallOrder[0]
    );
    resolveBarrier();
    const response = await confirmation;
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
  });

  it("LED reject bo'lsa exit payment, session va barrier oqimi davom etadi", async () => {
    const sessionId = await createSession("01P101AA");
    await postExit("01P101AA");
    const candidate = await candidateForPlate("01P101AA");
    const ledError = new Error("LED connection refused");
    ledMocks.showPayment.mockRejectedValueOnce(ledError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await confirm(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(consoleError).toHaveBeenCalledWith("LED_PAYMENT_FAILED", ledError);
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const payment = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    expect(session).toMatchObject({ status: "completed", payment_method: "cash" });
    expect(payment).toMatchObject({ payment_method: "cash" });
  });

  it("2. exact regular online completed va online payment yaratadi", async () => {
    const sessionId = await createSession("01A101AA");
    await postExit("01A101AA");
    const candidate = await candidateForPlate("01A101AA");
    await confirm(candidate.id, { payment_method: "online" });
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({
      status: "completed",
      payment_method: "online",
    });
    const payment = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    expect(payment).toMatchObject({
      payment_method: "online",
    });
  });

  it("3. exact VIP amount nol, paymentsiz completed va barrier open", async () => {
    const sessionId = await createSession("01V100AA", "vip");
    await postExit("01V100AA");
    const candidate = await candidateForPlate("01V100AA");
    await confirm(candidate.id, {});
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!session) throw new Error("VIP session topilmadi");
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
    const payments = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(payments).toHaveLength(0);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
  });

  it("4. exact subscription amount nol, paymentsiz completed va barrier open", async () => {
    const sessionId = await createSession("01S100AA", "subscription");
    await postExit("01S100AA");
    const candidate = await candidateForPlate("01S100AA");
    const response = await confirm(candidate.id, { payment_method: "online" });
    expect(response.status).toBe(200);
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!session) throw new Error("Subscription session topilmadi");
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
    const payments = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(payments).toHaveLength(0);
  });

  it("5. fuzzy search bir belgi xatosida to'g'ri sessiyani score bilan topadi", async () => {
    const sessionId = await createSession("01A123BC");
    await postExit("WRONG500");
    const candidate = await candidateForPlate("WRONG500");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/search`)
      .set("Authorization", authorizationHeader)
      .send({ plate: "01A12XBC" });
    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      session_id: String(sessionId),
      plate_number: "01A123BC",
      tariff_snapshot_amount: 10000,
      entry_images: { image_available: false },
    });
    expect(typeof response.body.results[0].similarity_score).toBe("number");
    expect(typeof response.body.results[0].duration_minutes).toBe("number");
    expect(response.body.results[0].similarity_score).toBeGreaterThan(80);
  });

  it("6. fuzzy search boshqa organization sessiyasini chiqarmaydi", async () => {
    await createSession("01A124BC", "regular", otherOrgId);
    await postExit("WRONG501");
    const candidate = await candidateForPlate("WRONG501");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/search`)
      .set("Authorization", authorizationHeader)
      .send({ plate: "01A124BX" });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([]);
  });

  it("7. session_id bilan confirm reassigned sessiyani yakunlaydi", async () => {
    const sessionId = await createSession("01A200AA");
    await postExit("WRONG502");
    const candidate = await candidateForPlate("WRONG502");
    const response = await confirm(candidate.id, {
      session_id: String(sessionId),
      payment_method: "cash",
    });
    expect(response.status).toBe(200);
    const reassignedSession = await queryTable<CompletionSessionRow>("tb_parking_sessions")
      .where({ id: sessionId })
      .first();
    const reassignedCandidate = await queryTable<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(reassignedSession).toMatchObject({ status: "completed" });
    expect(reassignedCandidate).toMatchObject({
      status: "accepted",
      resolution_type: "reassigned",
      resolved_session_id: sessionId,
    });
  });

  it("force-open reason berilmasa other bilan muvaffaqiyatli bajariladi", async () => {
    await postExit("UNKNOWNDEFAULT");
    const candidate = await candidateForPlate("UNKNOWNDEFAULT");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader);
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const forcedCandidate = await queryTable<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(forcedCandidate).toMatchObject({
      status: "dismissed",
      resolution_type: "forced_open",
      resolution_note: null,
    });
    const event = await queryTable("tb_webhook_events").where({ id: candidate.webhook_event_id }).first();
    expect(event).toMatchObject({
      processing_result: "exit_candidate_forced_open",
      processing_reason: "other",
    });
    const audit = await queryTable<ActivityLogRow>("tb_activity_logs")
      .where({ action: "exit_candidate.forced_open", target_id: candidate.id })
      .first();
    expect(audit?.details).toMatchObject({ reason: "other", note: null });
  });

  it("8. force-open session va paymentga tegmaydi, to'liq audit va barrier yaratadi", async () => {
    const sessionId = await createSession("01A300AA");
    const before = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!before) throw new Error("Force-open session topilmadi");
    await postExit("UNKNOWN1");
    const candidate = await candidateForPlate("UNKNOWN1");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader)
      .send({ reason: "camera_misread", note: "Operator tekshirdi", entered_plate: "01 A 300 AA" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const sessionAfter = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const paymentsAfter = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    const forcedCandidate = await queryTable<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(sessionAfter).toMatchObject({
      status: before.status,
      exited_at: before.exited_at,
      amount: before.amount,
      active_plate_key: before.active_plate_key,
    });
    expect(paymentsAfter).toHaveLength(0);
    expect(forcedCandidate).toMatchObject({
      status: "dismissed",
      resolution_type: "forced_open",
    });
    const audit = await queryTable<ActivityLogRow>("tb_activity_logs")
      .where({ action: "exit_candidate.forced_open", target_id: candidate.id })
      .first();
    if (!audit) throw new Error("Force-open audit topilmadi");
    expect(audit.details).toMatchObject({
      operatorId: actor.id,
      orgId,
      reason: "camera_misread",
      note: "Operator tekshirdi",
      enteredPlate: "01A300AA",
      candidateId: candidate.id,
      webhookEventId: candidate.webhook_event_id,
    });
    expect(typeof audit.details.exitImageRef).toBe("string");
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(emitExitCandidateResolved).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        candidateId: candidate.id,
        orgId,
        status: "dismissed",
        resolutionType: "forced_open",
        sessionId: null,
        barrierStatus: "opened",
      })
    );
  });

  it("9. retry-barrier faqat relay va yangi retry auditini bajaradi", async () => {
    const sessionId = await createSession("01A400AA");
    await postExit("01A400AA");
    const candidate: TestCandidateRow = await candidateForPlate("01A400AA");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const confirmResponse = await confirm(candidate.id, { payment_method: "cash" });
    expect(confirmResponse.body.barrier_status).toBe("failed");
    const sessionBefore = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const candidateBefore = await queryTable<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    const paymentsBefore = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    openBarrierMock.mockResolvedValueOnce({ status: "opened", success: true });
    const retry = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/retry-barrier`)
      .set("Authorization", authorizationHeader)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.barrier_status).toBe("opened");
    const sessionAfter = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const candidateAfter = await queryTable<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    const paymentsAfter = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(sessionAfter).toEqual(sessionBefore);
    expect(candidateAfter).toEqual(candidateBefore);
    expect(paymentsAfter).toEqual(paymentsBefore);
    const retryAudit = await queryTable<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_opened", target_id: candidate.id })
      .orderBy("id", "desc")
      .first();
    if (!retryAudit) throw new Error("Retry barrier audit topilmadi");
    expect(retryAudit.details).toMatchObject({ barrierStatus: "opened", retryAttempt: true });
  });

  it("10. candidate ikkinchi marta confirm qilinsa 409", async () => {
    await createSession("01A500AA");
    await postExit("01A500AA");
    const candidate: TestCandidateRow = await candidateForPlate("01A500AA");
    const first = await confirm(candidate.id, { payment_method: "cash" });
    expect(first.status).toBe(200);
    const second = await confirm(candidate.id, { payment_method: "cash" });
    expect(second.status).toBe(409);
    expect(second.body.message).toBe("Bu chiqish allaqachon hal qilingan");
  });

  it("11. cross-org candidate va session urinishlari bloklanadi", async () => {
    const ownSessionId = await createSession("01A600AA");
    const foreignSessionId = await createSession("01A601AA", "regular", otherOrgId);
    await postExit("WRONG600");
    const candidate = await candidateForPlate("WRONG600");
    const foreignCandidateAccess = await confirm(
      candidate.id,
      { session_id: ownSessionId, payment_method: "cash" },
      otherAuthorizationHeader
    );
    expect(foreignCandidateAccess.status).toBe(404);
    const foreignSessionAccess = await confirm(candidate.id, {
      session_id: foreignSessionId,
      payment_method: "cash",
    });
    expect(foreignSessionAccess.status).toBe(409);
    const foreignSession = await getSessionById(otherActor, foreignSessionId);
    expect(foreignSession?.status).toBe("active");
  });

  it("12. tanlangan session completed bo'lsa confirm 409", async () => {
    const sessionId = await createSession("01A700AA");
    await postExit("01A700AA");
    const candidate = await candidateForPlate("01A700AA");
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      exited_at: new Date(),
      active_plate_key: null,
    });
    const response = await confirm(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(409);
    const payments = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    const pendingCandidate = await queryTable<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    expect(payments).toHaveLength(0);
    expect(pendingCandidate?.status).toBe("pending");
  });

  it("13. confirm relay failed bo'lsa session va payment saqlanadi, failure audit yoziladi", async () => {
    const sessionId = await createSession("01A800AA");
    await postExit("01A800AA");
    const candidate = await candidateForPlate("01A800AA");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const response = await confirm(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("failed");
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const payments = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(session?.status).toBe("completed");
    expect(payments).toHaveLength(1);
    const failedBarrierAudit = await queryTable<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_open_failed", target_id: candidate.id })
      .first();
    expect(failedBarrierAudit).toBeTruthy();
  });

  it("14. force-open relay failed bo'lsa dismissed qaror saqlanadi", async () => {
    await postExit("UNKNOWN2");
    const candidate = await candidateForPlate("UNKNOWN2");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader)
      .send({ reason: "technical_issue" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("failed");
    const dismissedCandidate = await queryTable<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(dismissedCandidate).toMatchObject({
      status: "dismissed",
      resolution_type: "forced_open",
    });
    const failedBarrierAudit = await queryTable<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_open_failed", target_id: candidate.id })
      .first();
    expect(failedBarrierAudit).toBeTruthy();
  });

  it("15. amount entry tariff snapshotidan, active tarifdan emas", async () => {
    const sessionId = await createSession("01A900AA", "regular", orgId, 4000);
    await db("tb_tariffs").where({ org_id: orgId }).update({ price_per_hour: 99000 });
    await postExit("01A900AA");
    const candidate = await candidateForPlate("01A900AA");
    const response = await confirm(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    const session = await queryTable<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const payment = await queryTable<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    if (!session || !payment) throw new Error("Session yoki payment topilmadi");
    expect(Number(session.amount)).toBe(8000);
    expect(Number(payment.amount)).toBe(8000);
  });

  it("16. next pending candidate bo'lmasa 204 bodyless qaytaradi", async () => {
    const response = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorizationHeader);
    expect(response.status).toBe(204);
    expect(response.text).toBe("");
  });

  it("17. retry disabled va not_configured auditdan keyin konfiguratsiya xabari bilan 400 qaytaradi", async () => {
    for (const status of ["disabled", "not_configured"] as const) {
      const plate = status === "disabled" ? "UNKNOWN3" : "MISSING7";
      await postExit(plate);
      const candidate = await candidateForPlate(plate);
      openBarrierMock.mockResolvedValueOnce({ status, success: false });
      const forceOpen = await testRequest(app)
        .post(`/api/exit-candidates/${candidate.id}/force-open`)
        .set("Authorization", authorizationHeader)
        .send({ reason: "technical_issue" });
      expect(forceOpen.status).toBe(200);
      expect(forceOpen.body.barrier_status).toBe(status);
      const retry = await request
        .agent(app)
        .post(`/api/exit-candidates/${candidate.id}/retry-barrier`)
        .set("Authorization", authorizationHeader)
        .send({});
      expect(retry.status).toBe(400);
      expect(retry.body.message).toBe("Shlagbaum konfiguratsiya qilinmagan, administrator bilan bog'laning");
    }
  });

  it("18. bir xil plate uchun pending candidate yangilanadi va yangisi yaratilmaydi", async () => {
    await postExit("01D100AA", 61);
    const first = await candidateForPlate("01D100AA");
    await queryTable("tb_webhook_events").where({ id: first.webhook_event_id }).update({
      created_at: db.raw("DATE_SUB(NOW(), INTERVAL 20 SECOND)"),
    });
    const secondResponse = await postExit("01D100AA", 87);
    const candidates = await queryTable("tb_exit_candidates").where({
      org_id: orgId,
      detected_plate: "01D100AA",
    });
    expect(secondResponse.body).toMatchObject({
      candidate_created: false,
      candidate_coalesced: true,
      candidate_id: first.id,
    });
    expect(candidates).toHaveLength(1);
    expect(Number(candidates[0].confidence)).toBe(87);
  });

  it("19. plate null webhooklar 5 daqiqa ichida bitta pending candidate'da birlashadi", async () => {
    await postExit(null, 42, DateTime.now().minus({ seconds: 30 }));
    const secondResponse = await postExit(null, 73);
    const candidates = await queryTable("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereNull("detected_plate");
    expect(secondResponse.body).toMatchObject({
      candidate_created: false,
      candidate_coalesced: true,
    });
    expect(candidates).toHaveLength(1);
    expect(Number(candidates[0].confidence)).toBe(73);
  });

  it("20. plate null webhook 5 daqiqadan keyin yangi candidate yaratadi", async () => {
    await postExit(null, 44);
    await queryTable("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereNull("detected_plate")
      .update({ camera_event_at: new Date(Date.now() - 6 * 60_000) });
    const secondResponse = await postExit(null, 75);
    const candidates = await queryTable("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereNull("detected_plate");
    expect(secondResponse.body).toMatchObject({
      candidate_created: true,
      candidate_coalesced: false,
    });
    expect(candidates).toHaveLength(2);
  });

  it("21. turli plate'lar uchun alohida pending candidate'lar yaratiladi", async () => {
    await postExit("01D201AA");
    await postExit("01D299BB");
    const candidates = await queryTable("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereIn("detected_plate", ["01D201AA", "01D299BB"]);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.detected_plate))).toEqual(
      new Set(["01D201AA", "01D299BB"])
    );
  });
});
