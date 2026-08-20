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

interface CandidateRecord {
  id: number;
  org_id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  matched_session_id: number | null;
  status: string;
  confidence: string | number | null;
}

let orgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let authorizationHeader: string;
let jpegBase64: string;

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;
const openBarrierMock = openBarrier as unknown as ReturnType<typeof vi.fn>;

function dahuaPayload(plate: string, confidence: number, snapTime: DateTime) {
  return {
    Picture: {
      NormalPic: { Content: jpegBase64, PicName: "overview.jpg" },
      PlatePic: { Content: jpegBase64, PicName: "plate.jpg" },
    },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: confidence },
    Vehicle: { VehicleBoundingBox: { Left: 10, Top: 5, Right: 90, Bottom: 55 } },
    SnapInfo: {
      DeviceID: "fuzzy-camera",
      SnapTime: snapTime.toFormat("yyyy-MM-dd HH:mm:ss"),
    },
  };
}

async function postExit(
  plate: string,
  confidence = 91,
  snapTime = DateTime.now()
): Promise<request.Response> {
  return testRequest(app)
    .post(`/api/webhook/camera/${webhookToken}/exit`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plate, confidence, snapTime));
}

async function createSession(plate: string): Promise<number> {
  const id = await createTestActiveSession(orgId, plate, new Date(Date.now() - 61 * 60_000));
  await testDb("tb_parking_sessions").where({ id }).update({
    session_source: "regular",
    tariff_price_per_hour: 5000,
    tariff_grace_period_minutes: 0,
    tariff_intervals_snapshot: null,
  });
  return id;
}

async function listCandidates(): Promise<CandidateRecord[]> {
  return testDb<CandidateRecord>("tb_exit_candidates").where({ org_id: orgId }).orderBy("id", "asc");
}

async function latestCandidate(): Promise<CandidateRecord> {
  const candidate = await testDb<CandidateRecord>("tb_exit_candidates")
    .where({ org_id: orgId })
    .orderBy("id", "desc")
    .first();
  if (!candidate) throw new Error("Exit candidate topilmadi");
  return candidate;
}

async function createJpegBase64(): Promise<string> {
  const image = sharp({ create: { width: 100, height: 60, channels: 3, background: "#555" } });
  const buffer: Buffer = await image.jpeg().toBuffer();
  return buffer.toString("base64");
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = await createJpegBase64();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `fuzzy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await testDb("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
  authorizationHeader = `Bearer ${signAccessToken(actor)}`;
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
});

afterAll(closeDb);

describe("exit candidate fuzzy plate matching", () => {
  it("1. exact topilmasa, distance=1 farqli yagona active sessiya matched_session sifatida ishlatiladi", async () => {
    const sessionId = await createSession("01A123BC");
    const response = await postExit("01A123BD");
    expect(response.status).toBe(200);
    const candidate = await latestCandidate();
    expect(candidate).toMatchObject({
      detected_plate: "01A123BD",
      matched_session_id: sessionId,
    });
    const event = await testDb("tb_webhook_events").where({ id: candidate.webhook_event_id }).first();
    expect(event).toMatchObject({
      processing_result: "exit_candidate_pending",
      processing_reason: "exact_inside_session_found",
      session_id: sessionId,
    });
    const confirmResponse = await testRequest(app)
      .post(`/api/exit-candidates/${candidate.id}/confirm`)
      .set("Authorization", authorizationHeader)
      .send({ payment_method: "cash" });
    expect(confirmResponse.status).toBe(200);
    const session = await testDb("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({ status: "completed", payment_method: "cash" });
  });

  it("2. distance=1 bo'lgan bir nechta sessiya bo'lsa hech qaysi tanlanmaydi", async () => {
    await createSession("01A123BC");
    await createSession("01A123BD");
    const response = await postExit("01A123BX");
    expect(response.status).toBe(200);
    const candidate = await latestCandidate();
    expect(candidate).toMatchObject({
      detected_plate: "01A123BX",
      matched_session_id: null,
    });
    const event = await testDb("tb_webhook_events").where({ id: candidate.webhook_event_id }).first();
    expect(event).toMatchObject({ processing_reason: "inside_session_not_found" });
  });

  it("3. resolved cooldown distance=1 farqda ham qo'llanadi, yangi candidate yaratilmaydi", async () => {
    const sessionId = await createSession("01A150BC");
    await postExit("01A150BC");
    const resolved = await latestCandidate();
    const confirmResponse = await testRequest(app)
      .post(`/api/exit-candidates/${resolved.id}/confirm`)
      .set("Authorization", authorizationHeader)
      .send({ payment_method: "cash" });
    expect(confirmResponse.status).toBe(200);
    const response = await postExit("01A150BD");
    expect(response.body).toMatchObject({
      ignored: true,
      reason: "resolved_recently_ignored",
      session_id: sessionId,
    });
    const candidates = await listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(resolved.id);
  });

  it("4. distance=1 farqli webhook mavjud pending candidate'ga coalesce bo'ladi", async () => {
    const firstResponse = await postExit("01D310AA", 61);
    expect(firstResponse.body).toMatchObject({ candidate_created: true });
    const first = await latestCandidate();
    const secondResponse = await postExit("01D310AB", 87);
    expect(secondResponse.body).toMatchObject({
      candidate_created: false,
      candidate_coalesced: true,
      candidate_id: first.id,
    });
    const candidates = await listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].detected_plate).toBe("01D310AA");
    expect(Number(candidates[0].confidence)).toBe(87);
  });

  it("5. 6 belgidan qisqa plate'larda fuzzy qo'llanilmaydi", async () => {
    await createSession("01A1B");
    const response = await postExit("01A1C");
    expect(response.status).toBe(200);
    const candidate = await latestCandidate();
    expect(candidate).toMatchObject({
      detected_plate: "01A1C",
      matched_session_id: null,
    });
  });

  it("6. resolved cooldown'da bir nechta distance=1 nomzod bo'lsa cooldown qo'llanilmaydi", async () => {
    for (const plate of ["01A170BX", "01A170XC"]) {
      await postExit(plate);
      const candidate = await latestCandidate();
      const forceOpen = await testRequest(app)
        .post(`/api/exit-candidates/${candidate.id}/force-open`)
        .set("Authorization", authorizationHeader)
        .send({ reason: "technical_issue" });
      expect(forceOpen.status).toBe(200);
    }
    const response = await postExit("01A170BC");
    expect(response.body).toMatchObject({ candidate_created: true });
    const candidates = await listCandidates();
    expect(candidates).toHaveLength(3);
    expect(candidates[2].detected_plate).toBe("01A170BC");
    expect(candidates[2].status).toBe("pending");
  });

  it("7. pending coalescing'da bir nechta distance=1 nomzod bo'lsa coalesce qilinmaydi", async () => {
    await postExit("01D320AX");
    await postExit("01D320XB");
    const response = await postExit("01D320AB");
    expect(response.body).toMatchObject({
      candidate_created: true,
      candidate_coalesced: false,
    });
    const candidates = await listCandidates();
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((candidate) => candidate.detected_plate))).toEqual(
      new Set(["01D320AX", "01D320XB", "01D320AB"])
    );
  });

  it("8. distance=2 farqda fuzzy ishlamaydi, yangi mustaqil candidate yaratiladi", async () => {
    await createSession("01A160BC");
    const firstResponse = await postExit("01A160XY");
    expect(firstResponse.body).toMatchObject({ candidate_created: true });
    const firstCandidate = await latestCandidate();
    expect(firstCandidate.matched_session_id).toBeNull();
    const secondResponse = await postExit("01A160PQ");
    expect(secondResponse.body).toMatchObject({
      candidate_created: true,
      candidate_coalesced: false,
    });
    const candidates = await listCandidates();
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.detected_plate))).toEqual(
      new Set(["01A160XY", "01A160PQ"])
    );
  });
});
