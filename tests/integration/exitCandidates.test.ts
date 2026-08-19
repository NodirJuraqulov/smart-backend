import { promises as fs } from "fs";
import path from "path";
import express from "express";
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
import { ledService } from "@/modules/led/led.service";
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

vi.mock("@/modules/relay/relay.service", () => {
  const createMock = vi.fn as unknown as () => ReturnType<typeof vi.fn>;
  return { openBarrier: createMock() };
});

vi.mock("@/modules/led/led.service", () => ({
  ledService: {
    showPayment: vi.fn(),
    scheduleReturnToClock: vi.fn(),
  },
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
  const candidate = await db<TestCandidateRow>("tb_exit_candidates")
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

const testDb: typeof db = db;
const testRequest: typeof request = request;
const openBarrierMock = openBarrier as unknown as ReturnType<typeof vi.fn>;
const exitCandidateCreatedMock = emitExitCandidateCreated as unknown as ReturnType<typeof vi.fn>;

function createOrganizationForTest(
  overrides: { name?: string; is_active?: boolean; timezone?: string } = {}
): Promise<number> {
  return createTestOrganization(overrides);
}

function postExitForTest(
  plate: string | null,
  confidence = 91,
  snapTime = DateTime.now()
): Promise<request.Response> {
  return postExit(plate, confidence, snapTime);
}

function createSessionForTest(
  plate: string,
  source: "regular" | "vip" | "subscription" = "regular",
  ownerOrgId = orgId,
  pricePerHour = 5000
): Promise<number> {
  return createSession(plate, source, ownerOrgId, pricePerHour);
}

function findCandidateForTest(plate: string): Promise<TestCandidateRow> {
  return candidateForPlate(plate);
}

function createOwnerActorForTest(ownerOrgId: number): Promise<AuthTokenPayload> {
  return createOwnerActor(ownerOrgId);
}

function createJpegBase64ForTest(): Promise<string> {
  return createJpegBase64();
}

function confirmCandidateForTest(
  candidateId: number,
  body: Record<string, unknown>,
  authorization = authorizationHeader
): Promise<request.Response> {
  return confirm(candidateId, body, authorization);
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = await createJpegBase64ForTest();
});

beforeEach(async () => {
  orgId = await createOrganizationForTest({ timezone: "Asia/Tashkent" });
  otherOrgId = await createOrganizationForTest({ timezone: "Asia/Tashkent" });
  webhookToken = `candidate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestTariff(otherOrgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  actor = await createOwnerActorForTest(orgId);
  otherActor = await createOwnerActorForTest(otherOrgId);
  authorizationHeader = `Bearer ${signAccessToken(actor)}`;
  otherAuthorizationHeader = `Bearer ${signAccessToken(otherActor)}`;
  openBarrierMock.mockReset();
  openBarrierMock.mockResolvedValue({ status: "opened", success: true });
  vi.clearAllMocks();
});

afterEach(async () => {
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
  it("1. exact regular cash completed, payment va next response to'g'ri", async () => {
    const sessionId = await createSessionForTest("01A100AA");
    await postExitForTest("01A100AA");
    const candidate = await findCandidateForTest("01A100AA");
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
    const response = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({
      status: "completed",
      payment_method: "cash",
      active_plate_key: null,
    });
    const payment = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    expect(payment).toMatchObject({ payment_method: "cash" });
    expect(Number(payment.amount)).toBe(10000);
    expect(ledService.showPayment).toHaveBeenCalledWith("01A100AA", 10000);
    expect(ledService.scheduleReturnToClock).toHaveBeenCalledTimes(1);
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

  it("2. exact regular online completed va online payment yaratadi", async () => {
    const sessionId = await createSessionForTest("01A101AA");
    await postExitForTest("01A101AA");
    const candidate = await findCandidateForTest("01A101AA");
    await confirmCandidateForTest(candidate.id, { payment_method: "online" });
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({
      status: "completed",
      payment_method: "online",
    });
    const payment = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
    expect(payment).toMatchObject({
      payment_method: "online",
    });
  });

  it("3. exact VIP amount nol, paymentsiz completed va barrier open", async () => {
    const sessionId = await createSessionForTest("01V100AA", "vip");
    await postExitForTest("01V100AA");
    const candidate = await findCandidateForTest("01V100AA");
    await confirmCandidateForTest(candidate.id, {});
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!session) throw new Error("VIP session topilmadi");
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
    const payments = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(payments).toHaveLength(0);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
  });

  it("4. exact subscription amount nol, paymentsiz completed va barrier open", async () => {
    const sessionId = await createSessionForTest("01S100AA", "subscription");
    await postExitForTest("01S100AA");
    const candidate = await findCandidateForTest("01S100AA");
    const response = await confirmCandidateForTest(candidate.id, { payment_method: "online" });
    expect(response.status).toBe(200);
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!session) throw new Error("Subscription session topilmadi");
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
    const payments = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(payments).toHaveLength(0);
  });

  it("5. fuzzy search bir belgi xatosida to'g'ri sessiyani score bilan topadi", async () => {
    const sessionId = await createSessionForTest("01A123BC");
    await postExitForTest("WRONG500");
    const candidate = await findCandidateForTest("WRONG500");
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
    await createSessionForTest("01A124BC", "regular", otherOrgId);
    await postExitForTest("WRONG501");
    const candidate = await findCandidateForTest("WRONG501");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/search`)
      .set("Authorization", authorizationHeader)
      .send({ plate: "01A124BX" });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([]);
  });

  it("7. session_id bilan confirm reassigned sessiyani yakunlaydi", async () => {
    const sessionId = await createSessionForTest("01A200AA");
    await postExitForTest("WRONG502");
    const candidate = await findCandidateForTest("WRONG502");
    const response = await confirmCandidateForTest(candidate.id, {
      session_id: String(sessionId),
      payment_method: "cash",
    });
    expect(response.status).toBe(200);
    const reassignedSession = await testDb<CompletionSessionRow>("tb_parking_sessions")
      .where({ id: sessionId })
      .first();
    const reassignedCandidate = await testDb<CandidateStateRow>("tb_exit_candidates")
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
    await postExitForTest("UNKNOWNDEFAULT");
    const candidate = await findCandidateForTest("UNKNOWNDEFAULT");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader);
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const forcedCandidate = await testDb<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(forcedCandidate).toMatchObject({
      status: "dismissed",
      resolution_type: "forced_open",
      resolution_note: null,
    });
    const event = await testDb("tb_webhook_events").where({ id: candidate.webhook_event_id }).first();
    expect(event).toMatchObject({
      processing_result: "exit_candidate_forced_open",
      processing_reason: "other",
    });
    const audit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "exit_candidate.forced_open", target_id: candidate.id })
      .first();
    expect(audit?.details).toMatchObject({ reason: "other", note: null });
  });

  it("8. force-open session va paymentga tegmaydi, to'liq audit va barrier yaratadi", async () => {
    const sessionId = await createSessionForTest("01A300AA");
    const before = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    if (!before) throw new Error("Force-open session topilmadi");
    await postExitForTest("UNKNOWN1");
    const candidate = await findCandidateForTest("UNKNOWN1");
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader)
      .send({ reason: "camera_misread", note: "Operator tekshirdi", entered_plate: "01 A 300 AA" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("opened");
    const sessionAfter = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const paymentsAfter = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    const forcedCandidate = await testDb<CandidateStateRow>("tb_exit_candidates")
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
    const audit = await db<ActivityLogRow>("tb_activity_logs")
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
    const sessionId = await createSessionForTest("01A400AA");
    await postExitForTest("01A400AA");
    const candidate: TestCandidateRow = await findCandidateForTest("01A400AA");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const confirmResponse = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(confirmResponse.body.barrier_status).toBe("failed");
    const sessionBefore = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const candidateBefore = await testDb<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    const paymentsBefore = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    openBarrierMock.mockResolvedValueOnce({ status: "opened", success: true });
    const retry = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/retry-barrier`)
      .set("Authorization", authorizationHeader)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.barrier_status).toBe("opened");
    const sessionAfter = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const candidateAfter = await testDb<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    const paymentsAfter = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(sessionAfter).toEqual(sessionBefore);
    expect(candidateAfter).toEqual(candidateBefore);
    expect(paymentsAfter).toEqual(paymentsBefore);
    const retryAudit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_opened", target_id: candidate.id })
      .orderBy("id", "desc")
      .first();
    if (!retryAudit) throw new Error("Retry barrier audit topilmadi");
    expect(retryAudit.details).toMatchObject({ barrierStatus: "opened", retryAttempt: true });
  });

  it("10. candidate ikkinchi marta confirm qilinsa 409", async () => {
    await createSessionForTest("01A500AA");
    await postExitForTest("01A500AA");
    const candidate: TestCandidateRow = await findCandidateForTest("01A500AA");
    const first = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(first.status).toBe(200);
    const second = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(second.status).toBe(409);
    expect(second.body.message).toBe("Bu chiqish allaqachon hal qilingan");
  });

  it("11. cross-org candidate va session urinishlari bloklanadi", async () => {
    const ownSessionId = await createSessionForTest("01A600AA");
    const foreignSessionId = await createSessionForTest("01A601AA", "regular", otherOrgId);
    await postExitForTest("WRONG600");
    const candidate = await findCandidateForTest("WRONG600");
    const foreignCandidateAccess = await confirmCandidateForTest(
      candidate.id,
      { session_id: ownSessionId, payment_method: "cash" },
      otherAuthorizationHeader
    );
    expect(foreignCandidateAccess.status).toBe(404);
    const foreignSessionAccess = await confirmCandidateForTest(candidate.id, {
      session_id: foreignSessionId,
      payment_method: "cash",
    });
    expect(foreignSessionAccess.status).toBe(409);
    const foreignSession = await testDb<CompletionSessionRow>("tb_parking_sessions")
      .where({ id: foreignSessionId })
      .first();
    expect(foreignSession?.status).toBe("active");
  });

  it("12. tanlangan session completed bo'lsa confirm 409", async () => {
    await createSessionForTest("01A700AA");
    const session = await testDb<{ id: number }>("tb_parking_sessions")
      .select("id")
      .where({ org_id: orgId, plate_number: "01A700AA", status: "active" })
      .first();
    if (!session) throw new Error("Completed qilinadigan session topilmadi");
    const sessionId = session.id;
    await postExitForTest("01A700AA");
    const candidate = await findCandidateForTest("01A700AA");
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      exited_at: new Date(),
      active_plate_key: null,
    });
    const response = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(409);
    const payments = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    const pendingCandidate = await testDb<CandidateStateRow>("tb_exit_candidates").where({ id: candidate.id }).first();
    expect(payments).toHaveLength(0);
    expect(pendingCandidate?.status).toBe("pending");
  });

  it("13. confirm relay failed bo'lsa session va payment saqlanadi, failure audit yoziladi", async () => {
    const sessionId = await createSessionForTest("01A800AA");
    await postExitForTest("01A800AA");
    const candidate = await findCandidateForTest("01A800AA");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const response = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("failed");
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const payments = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId });
    expect(session?.status).toBe("completed");
    expect(payments).toHaveLength(1);
    const failedBarrierAudit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_open_failed", target_id: candidate.id })
      .first();
    expect(failedBarrierAudit).toBeTruthy();
  });

  it("14. force-open relay failed bo'lsa dismissed qaror saqlanadi", async () => {
    await postExitForTest("UNKNOWN2");
    const candidate = await findCandidateForTest("UNKNOWN2");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false });
    const response = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/force-open`)
      .set("Authorization", authorizationHeader)
      .send({ reason: "technical_issue" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("failed");
    const dismissedCandidate = await testDb<CandidateStateRow>("tb_exit_candidates")
      .where({ id: candidate.id })
      .first();
    expect(dismissedCandidate).toMatchObject({
      status: "dismissed",
      resolution_type: "forced_open",
    });
    const failedBarrierAudit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_open_failed", target_id: candidate.id })
      .first();
    expect(failedBarrierAudit).toBeTruthy();
  });

  it("15. amount entry tariff snapshotidan, active tarifdan emas", async () => {
    const sessionId = await createSessionForTest("01A900AA", "regular", orgId, 4000);
    await db("tb_tariffs").where({ org_id: orgId }).update({ price_per_hour: 99000 });
    await postExitForTest("01A900AA");
    const candidate = await findCandidateForTest("01A900AA");
    const response = await confirmCandidateForTest(candidate.id, { payment_method: "cash" });
    expect(response.status).toBe(200);
    const session = await testDb<CompletionSessionRow>("tb_parking_sessions").where({ id: sessionId }).first();
    const payment = await testDb<PaymentRow>("tb_payments").where({ session_id: sessionId }).first();
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
      await postExitForTest(plate);
      const candidate = await findCandidateForTest(plate);
      openBarrierMock.mockResolvedValueOnce({ status, success: false });
      const forceOpen = await testRequest(app)
        .post(`/api/exit-candidates/${candidate.id}/force-open`)
        .set("Authorization", authorizationHeader)
        .send({ reason: "technical_issue" });
      expect(forceOpen.status).toBe(200);
      expect(forceOpen.body.barrier_status).toBe(status);
      const retry = await testRequest(app)
        .post(`/api/exit-candidates/${candidate.id}/retry-barrier`)
        .set("Authorization", authorizationHeader)
        .send({});
      expect(retry.status).toBe(400);
      expect(retry.body.message).toBe("Shlagbaum konfiguratsiya qilinmagan, administrator bilan bog'laning");
    }
  });

  it("18. bir xil plate uchun pending candidate yangilanadi va yangisi yaratilmaydi", async () => {
    await postExitForTest("01D100AA", 61);
    const first = await findCandidateForTest("01D100AA");
    await testDb("tb_webhook_events").where({ id: first.webhook_event_id }).update({
      created_at: testDb.raw("DATE_SUB(NOW(), INTERVAL 20 SECOND)"),
    });
    const secondResponse = await postExitForTest("01D100AA", 87);
    const candidates = await testDb("tb_exit_candidates").where({
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
    await postExitForTest(null, 42, DateTime.now().minus({ seconds: 30 }));
    const secondResponse = await postExitForTest(null, 73);
    const candidates = await testDb("tb_exit_candidates")
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
    await postExitForTest(null, 44);
    await testDb("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereNull("detected_plate")
      .update({ camera_event_at: new Date(Date.now() - 6 * 60_000) });
    const secondResponse = await postExitForTest(null, 75);
    const candidates = await testDb("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereNull("detected_plate");
    expect(secondResponse.body).toMatchObject({
      candidate_created: true,
      candidate_coalesced: false,
    });
    expect(candidates).toHaveLength(2);
  });

  it("21. turli plate'lar uchun alohida pending candidate'lar yaratiladi", async () => {
    await postExitForTest("01D201AA");
    await postExitForTest("01D299BB");
    const candidates = await testDb("tb_exit_candidates")
      .where({ org_id: orgId, status: "pending" })
      .whereIn("detected_plate", ["01D201AA", "01D299BB"]);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.detected_plate))).toEqual(
      new Set(["01D201AA", "01D299BB"])
    );
  });
});
