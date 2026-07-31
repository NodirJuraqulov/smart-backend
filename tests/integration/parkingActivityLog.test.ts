import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import webhookRouter from "@/modules/webhook/webhook.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
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

function buildHikvisionBody(plateNumber: string, confidence = 92): { contentType: string; rawBody: Buffer } {
  const boundary = `Boundary${Math.random().toString(36).slice(2)}`;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<EventNotificationAlert>" +
    "<dateTime>2026-07-25T10:00:00+05:00</dateTime>" +
    `<ANPR><licensePlate>${plateNumber}</licensePlate><confidenceLevel>${confidence}</confidenceLevel></ANPR>` +
    "</EventNotificationAlert>";
  const rawBody = Buffer.from(
    `--${boundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`
  );
  return { contentType: `multipart/form-data; boundary=${boundary}`, rawBody };
}

async function postWebhook(direction: "entry" | "exit", plateNumber: string) {
  const { contentType, rawBody } = buildHikvisionBody(plateNumber);
  return request(buildApp())
    .post(`/api/webhook/hikvision/${webhookToken}/${direction}`)
    .set("Content-Type", contentType)
    .send(rawBody);
}

async function lastLogFor(action: string) {
  return db("tb_activity_logs").where({ action }).orderBy("id", "desc").first();
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
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

describe("Activity log — parking.exit_webhook", () => {
  it("webhook chiqishda (awaiting_payment) actor_id null bilan yozuv yaratiladi", async () => {
    await postWebhook("entry", "01K222AA");

    const res = await postWebhook("exit", "01K222AA");
    expect(res.status).toBe(200);

    const log = await lastLogFor("parking.exit_webhook");
    expect(log).toBeTruthy();
    expect(log.actor_id).toBeNull();
    expect(log.details).toMatchObject({ plateNumber: "01K222AA" });
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
