import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import sharp from "sharp";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import {
  acceptExitCandidate,
  createExitCandidate,
  dismissExitCandidate,
  reassignExitCandidate,
} from "@/modules/exitCandidates/exitCandidates.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  emitExitAwaitingPayment,
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

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let jpegBase64: string;

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

function authHeader(): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function dahuaPayload(plate: string) {
  return {
    Picture: {
      NormalPic: { Content: jpegBase64, PicName: "overview.jpg" },
      PlatePic: { Content: jpegBase64, PicName: "plate.jpg" },
    },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 91 },
    SnapInfo: {
      DeviceID: "candidate-camera",
      SnapTime: DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss"),
    },
  };
}

async function postExit(plate: string) {
  return request(app)
    .post(`/api/webhook/camera/${webhookToken}/exit`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plate));
}

async function candidateForPlate(plate: string) {
  return db("tb_exit_candidates").where({ org_id: orgId, detected_plate: plate }).orderBy("id", "desc").first();
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = (
    await sharp({ create: { width: 100, height: 60, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
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
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearWebhookDedupeCache();
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("safe exit candidate workflow", () => {
  it("exact regular exit pending candidate yaratadi va session/payment/barrierga tegmaydi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01A100AA", new Date(Date.now() - 65 * 60_000));
    const before = await db("tb_parking_sessions").where({ id: sessionId }).first();

    const response = await postExit("01A100AA");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ parsed: true, candidate_created: true });

    const candidate = await candidateForPlate("01A100AA");
    expect(candidate).toMatchObject({ status: "pending", matched_session_id: sessionId });
    const after = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(after.status).toBe("active");
    expect(after.exited_at).toEqual(before.exited_at);
    expect(after.duration_minutes).toEqual(before.duration_minutes);
    expect(after.amount).toEqual(before.amount);
    expect(after.active_plate_key).toBe(before.active_plate_key);
    expect(await db("tb_payments").where({ org_id: orgId })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    expect(emitExitCandidateCreated).toHaveBeenCalledWith(orgId, expect.objectContaining({ id: candidate.id }));

    const list = await request(app).get("/api/exit-candidates").set("Authorization", authHeader());
    expect(list.status).toBe(200);
    expect(list.body.candidates[0]).toMatchObject({
      id: candidate.id,
      detected_plate: "01A100AA",
      matched_session: { id: sessionId },
      overviewImageUrl: expect.any(String),
      plateImageUrl: expect.any(String),
    });
  });

  it.each(["vip", "subscription"] as const)(
    "%s camera eventi sessionni avtomatik completed qilmaydi",
    async (source) => {
      const sessionId = await createTestActiveSession(orgId, `${source}-PLATE`);
      await db("tb_parking_sessions").where({ id: sessionId }).update({ session_source: source });
      await postExit(`${source}-PLATE`);
      const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
      expect(session.status).toBe("active");
      expect(openBarrier).not.toHaveBeenCalled();
      expect(emitExitCompleted).not.toHaveBeenCalled();
    }
  );

  it("unmatched exit candidate va rasmlarni session_id=null bilan saqlaydi", async () => {
    await postExit("01A404AA");
    const candidate = await candidateForPlate("01A404AA");
    expect(candidate).toMatchObject({ status: "pending", matched_session_id: null });
    const event = await db("tb_webhook_events").where({ id: candidate.webhook_event_id }).first();
    expect(event.overview_image_path).toBeTruthy();
    expect(event.processing_result).toBe("exit_candidate_pending");
  });

  it("bir webhook event bitta candidate, takroriy event esa pending candidate bilan coalesce bo'ladi", async () => {
    await createTestActiveSession(orgId, "01A200AA");
    await postExit("01A200AA");
    const first = await candidateForPlate("01A200AA");
    const sameEvent = await createExitCandidate({
      orgId,
      webhookEventId: first.webhook_event_id,
      detectedPlate: "01A200AA",
      confidence: 91,
    });
    expect(sameEvent.candidate.id).toBe(first.id);
    expect(sameEvent.created).toBe(false);

    await db("tb_webhook_events").where({ id: first.webhook_event_id }).update({
      created_at: db.raw("NOW() - INTERVAL 11 SECOND"),
      camera_event_at: null,
    });
    const repeated = await postExit("01A200AA");
    expect(repeated.body).toMatchObject({ candidate_created: false, candidate_coalesced: true, candidate_id: first.id });
    const [{ count }] = await db("tb_exit_candidates")
      .where({ org_id: orgId })
      .count<{ count: string }[]>("id as count");
    expect(Number(count)).toBe(1);
    expect(emitExitCandidateCreated).toHaveBeenCalledTimes(1);
  });

  it("regular accept awaiting_payment qiladi, payment/barrier yaratmaydi va qayta resolve 409", async () => {
    const sessionId = await createTestActiveSession(orgId, "01A300AA", new Date(Date.now() - 61 * 60_000));
    await postExit("01A300AA");
    const candidate = await candidateForPlate("01A300AA");
    vi.clearAllMocks();

    await acceptExitCandidate(actor, undefined, candidate.id);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session.status).toBe("awaiting_payment");
    expect(session.exited_at).toBeTruthy();
    expect(session.duration_minutes).toBeGreaterThanOrEqual(61);
    expect(Number(session.amount)).toBe(10000);
    expect(session.active_plate_key).toBe(`${orgId}:01A300AA`);
    expect(await db("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitExitAwaitingPayment).toHaveBeenCalledOnce();
    expect(emitExitCandidateResolved).toHaveBeenCalledWith(orgId, expect.objectContaining({ status: "accepted" }));
    await expect(acceptExitCandidate(actor, undefined, candidate.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("awaiting_payment sessiya keyingi eventlarda yangi yoki unmatched candidate yaratmaydi", async () => {
    const plate = "01A301AA";
    const sessionId = await createTestActiveSession(orgId, plate, new Date(Date.now() - 61 * 60_000));
    await postExit(plate);
    const candidate = await candidateForPlate(plate);
    await acceptExitCandidate(actor, undefined, candidate.id);
    const acceptedSession = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(acceptedSession.status).toBe("awaiting_payment");
    vi.clearAllMocks();

    await db("tb_webhook_events")
      .where({ org_id: orgId, direction: "exit", plate_number: plate })
      .update({ camera_event_at: null, created_at: new Date(Date.now() - 15_000) });
    const insideCoalesceWindow = await postExit(plate);
    expect(insideCoalesceWindow.body).toMatchObject({
      parsed: true,
      ignored: true,
      reason: "already_awaiting_payment",
      session_id: sessionId,
    });

    await db("tb_webhook_events")
      .where({ org_id: orgId, direction: "exit", plate_number: plate })
      .update({ camera_event_at: null, created_at: new Date(Date.now() - 31_000) });
    const afterCoalesceWindow = await postExit(plate);
    expect(afterCoalesceWindow.body).toMatchObject({
      parsed: true,
      ignored: true,
      reason: "already_awaiting_payment",
      session_id: sessionId,
    });

    expect(await db("tb_exit_candidates").where({ id: candidate.id, org_id: orgId }).first()).toMatchObject({
      status: "accepted",
      detected_plate: plate,
      resolved_session_id: sessionId,
    });
    const [{ extraCandidateCount }] = await db("tb_exit_candidates")
      .where({ org_id: orgId })
      .whereNot({ id: candidate.id })
      .count<{ extraCandidateCount: string }[]>("id as extraCandidateCount");
    expect(Number(extraCandidateCount)).toBe(0);
    const sessionAfter = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(sessionAfter).toMatchObject({
      status: "awaiting_payment",
      exited_at: acceptedSession.exited_at,
      duration_minutes: acceptedSession.duration_minutes,
      amount: acceptedSession.amount,
      active_plate_key: acceptedSession.active_plate_key,
    });
    expect(await db("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitExitCandidateCreated).not.toHaveBeenCalled();

    const latestAudit = await db("tb_webhook_events")
      .where({ org_id: orgId, direction: "exit", plate_number: plate })
      .orderBy("id", "desc")
      .first();
    expect(latestAudit).toMatchObject({
      processing_result: "already_awaiting_payment",
      processing_reason: "session_already_awaiting_payment",
      session_id: sessionId,
      processed_at: null,
    });
  });

  it.each(["vip", "subscription"] as const)("%s accept completed qiladi va barrier ochadi", async (source) => {
    const plate = source === "vip" ? "01V100AA" : "01S100AA";
    const sessionId = await createTestActiveSession(orgId, plate, new Date(Date.now() - 10 * 60_000));
    await db("tb_parking_sessions").where({ id: sessionId }).update({ session_source: source });
    await postExit(plate);
    const candidate = await candidateForPlate(plate);
    vi.clearAllMocks();

    await acceptExitCandidate(actor, undefined, candidate.id);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session).toMatchObject({ status: "completed", active_plate_key: null });
    expect(Number(session.amount)).toBe(0);
    expect(await db("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(emitExitCompleted).toHaveBeenCalledWith(orgId, expect.objectContaining({ plateNumber: plate, amount: 0 }));
  });

  it("reassign active sessiyaga ishlaydi, cross-org sessiyani bloklaydi", async () => {
    const selectedId = await createTestActiveSession(orgId, "01A500AA");
    await postExit("WRONG500");
    const candidate = await candidateForPlate("WRONG500");
    await reassignExitCandidate(actor, undefined, candidate.id, selectedId);
    expect((await db("tb_parking_sessions").where({ id: selectedId }).first()).status).toBe("awaiting_payment");
    expect((await db("tb_exit_candidates").where({ id: candidate.id }).first()).resolution_type).toBe("reassigned");

    await clearWebhookDedupeCache();
    await postExit("WRONG501");
    const crossCandidate = await candidateForPlate("WRONG501");
    const foreignSessionId = await createTestActiveSession(otherOrgId, "FOREIGN501");
    await expect(
      reassignExitCandidate(actor, undefined, crossCandidate.id, foreignSessionId)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await db("tb_parking_sessions").where({ id: foreignSessionId }).first()).status).toBe("active");
  });

  it("dismiss sessionga tegmaydi va ikkinchi resolve'ni bloklaydi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01A600AA");
    await postExit("01A600AA");
    const candidate = await candidateForPlate("01A600AA");
    await dismissExitCandidate(actor, undefined, candidate.id, "OCR noto'g'ri");
    expect((await db("tb_parking_sessions").where({ id: sessionId }).first()).status).toBe("active");
    expect(await db("tb_exit_candidates").where({ id: candidate.id }).first()).toMatchObject({
      status: "dismissed",
      resolution_type: "dismissed",
      resolution_note: "OCR noto'g'ri",
    });
    expect(openBarrier).not.toHaveBeenCalled();
    await expect(dismissExitCandidate(actor, undefined, candidate.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});
