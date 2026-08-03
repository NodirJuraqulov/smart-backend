import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import webhookRouter from "@/modules/webhook/webhook.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestAwaitingPaymentSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitEntryBarrierFailed: vi.fn(),
  emitEntryCandidateCreated: vi.fn(),
  emitEntryCandidateResolved: vi.fn(),
  emitEntryCompleted: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));
vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));
vi.mock("@/modules/printer/printer.service", () => ({
  printReceipt: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

let orgId: number;
let webhookToken: string;
let operator: AuthTokenPayload;
let jpegBase64: string;

function buildApp() {
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/parking", parkingRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function buildDahuaBody(plateNumber: string) {
  return {
    Picture: { NormalPic: { Content: jpegBase64, PicName: `${plateNumber}.jpg` } },
    Plate: { IsExist: true, PlateNumber: plateNumber, Confidence: 92 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "activity-camera", SnapTime: new Date().toISOString() },
  };
}

async function postWebhook(direction: "entry" | "exit", plateNumber: string) {
  return request(buildApp())
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(buildDahuaBody(plateNumber));
}

async function lastLogFor(action: string) {
  return db("tb_activity_logs").where({ action }).orderBy("id", "desc").first();
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(process.cwd(), "uploads", "parking", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("Activity log — parking.entry_webhook", () => {
  it("webhook kirishda actor_id null bilan yozuv yaratiladi", async () => {
    const res = await postWebhook("entry", "01K111AA");
    expect(res.status).toBe(200);

    const log = await lastLogFor("parking.entry_webhook");
    expect(log).toBeTruthy();
    expect(log.actor_id).toBeNull();
    expect(log.target_type).toBe("session");
    expect(log.details).toMatchObject({ plateNumber: "01K111AA", orgId });
  });
});

describe("Activity log — parking.exit_candidate_created", () => {
  it("webhook chiqishda sessiyaga tegmaydi va system candidate auditini yozadi", async () => {
    await postWebhook("entry", "01K222AA");
    const before = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01K222AA" })
      .first();
    vi.clearAllMocks();

    const res = await postWebhook("exit", "01K222AA");
    expect(res.status).toBe(200);

    const candidate = await db("tb_exit_candidates")
      .where({ org_id: orgId, detected_plate: "01K222AA" })
      .first();
    expect(candidate).toMatchObject({ status: "pending", matched_session_id: before.id });

    const session = await db("tb_parking_sessions").where({ id: before.id }).first();
    expect(session).toMatchObject({
      status: "active",
      exited_at: before.exited_at,
      duration_minutes: before.duration_minutes,
      amount: before.amount,
      active_plate_key: before.active_plate_key,
    });
    expect(await db("tb_payments").where({ session_id: before.id })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();

    const webhookEvent = await db("tb_webhook_events")
      .where({ org_id: orgId, direction: "exit", plate_number: "01K222AA" })
      .first();
    expect(webhookEvent).toMatchObject({
      processing_result: "exit_candidate_pending",
      processing_reason: "exact_inside_session_found",
      session_id: before.id,
    });

    const log = await lastLogFor("parking.exit_candidate_created");
    expect(log).toBeTruthy();
    expect(log.actor_id).toBeNull();
    expect(log.target_type).toBe("exit_candidate");
    expect(log.target_id).toBe(candidate.id);
    expect(log.details).toMatchObject({
      candidateId: candidate.id,
      detectedPlate: "01K222AA",
      matchedSessionId: before.id,
      webhookEventId: webhookEvent.id,
      confidence: 92,
    });
    expect(
      await db("tb_activity_logs").where({ action: "parking.exit_webhook", target_id: before.id }).first()
    ).toBeUndefined();
  });
});

describe("Activity log — parking.cash_payment_confirmed", () => {
  it("naqd to'lov tasdiqlanganda operator actor_id bilan yozuv yaratiladi", async () => {
    const sessionId = await createTestAwaitingPaymentSession(orgId, "01K333AA", { amount: 12000 });

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);

    const log = await lastLogFor("parking.cash_payment_confirmed");
    expect(log).toBeTruthy();
    expect(log.actor_id).toBe(operator.id);
    expect(log.details).toMatchObject({
      plateNumber: "01K333AA",
      amount: 12000,
      actorId: operator.id,
    });
  });
});

describe("Activity log — session.force_closed", () => {
  it("majburan yopilganda operator actor_id bilan yozuv yaratiladi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01K444AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/force-close`)
      .set("Authorization", authHeader(operator))
      .send({});

    expect(res.status).toBe(200);

    const log = await lastLogFor("session.force_closed");
    expect(log).toBeTruthy();
    expect(log.actor_id).toBe(operator.id);
    expect(log.target_id).toBe(sessionId);
  });
});
