import http from "http";
import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingRouter from "@/modules/parking/parking.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
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
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true, detail: "opened" }),
}));

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
  emitPublicEntryStatusChanged: vi.fn(),
  emitPublicExitStatusChanged: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

interface SessionRow {
  id: number;
  plate_number: string;
  status: string;
  entered_at: Date;
  exited_at: Date | null;
  duration_minutes: number | null;
  amount: string | number | null;
  exit_method: string | null;
  active_plate_key: string | null;
}

interface ActivityLogRow {
  id: number;
  actor_id: number | null;
  action: string;
  target_type: string;
  target_id: number;
  details: Record<string, unknown>;
}

const STALE_HOURS = 30;

let server: http.Server;
let orgId: number;
let owner: AuthTokenPayload;
let webhookToken: string;
let jpegBase64: string;

const testDb: typeof db = db;
const testRequest: typeof request = request;

function dahuaEntryBody(plate: string) {
  return {
    Picture: { NormalPic: { Content: jpegBase64, PicName: `${plate}.jpg` } },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 93 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "reentry-camera", SnapTime: new Date().toISOString() },
  };
}

function authHeader(): string {
  return `Bearer ${signAccessToken(owner)}`;
}

async function postCameraEntry(plate: string) {
  return testRequest(server)
    .post(`/api/webhook/camera/${webhookToken}/entry`)
    .set("Content-Type", "application/json")
    .send(dahuaEntryBody(plate));
}

async function expireWebhookDedupeWindow(): Promise<void> {
  await testDb("tb_webhook_events")
    .where({ org_id: orgId })
    .update({ created_at: testDb.raw("DATE_SUB(NOW(), INTERVAL 20 SECOND)") });
}

async function createStaleActiveSession(plate: string): Promise<number> {
  return createTestActiveSession(orgId, plate, new Date(Date.now() - STALE_HOURS * 3600_000));
}

async function sessionsForPlate(plate: string): Promise<SessionRow[]> {
  return testDb<SessionRow>("tb_parking_sessions")
    .where({ org_id: orgId, plate_number: plate })
    .orderBy("id", "asc");
}

async function sessionById(id: number): Promise<SessionRow> {
  const session = await testDb<SessionRow>("tb_parking_sessions").where({ id }).first();
  if (!session) throw new Error(`Sessiya topilmadi: ${id}`);
  return session;
}

async function autoCloseLogs(): Promise<ActivityLogRow[]> {
  const sessionIds: number[] = await testDb("tb_parking_sessions").where({ org_id: orgId }).pluck("id");
  if (sessionIds.length === 0) return [];
  return testDb<ActivityLogRow>("tb_activity_logs")
    .where({ action: "session_auto_closed_on_reentry", target_type: "session" })
    .whereIn("target_id", sessionIds)
    .orderBy("id", "asc");
}

function minutesSince(value: Date): number {
  return (Date.now() - new Date(value).getTime()) / 60_000;
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/parking", parkingRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  jpegBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `reentry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await testDb("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const user = await createTestUser(orgId, { role: "owner" });
  owner = { id: user.id, org_id: orgId, role: "owner" };
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearWebhookDedupeCache(orgId);
  for (const folder of ["parking-events", "parking"]) {
    await fs.rm(path.join(process.cwd(), "uploads", folder, String(orgId)), {
      recursive: true,
      force: true,
    });
  }
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("qayta kirishda eskirgan sessiyani avtomatik yopish", () => {
  it("1. kamera kirishi eski active sessiyani yopadi va yangi toza sessiya ochadi", async () => {
    const staleId = await createStaleActiveSession("01R100AA");
    const response = await postCameraEntry("01R100AA");
    expect(response.status).toBe(200);

    const stale = await sessionById(staleId);
    expect(stale).toMatchObject({
      status: "completed",
      amount: "0.00",
      exit_method: "auto_closed_on_reentry",
      active_plate_key: null,
    });
    expect(stale.exited_at).not.toBeNull();

    const stalePayments = await testDb("tb_payments").where({ session_id: staleId });
    expect(stalePayments).toHaveLength(0);

    const sessions = await sessionsForPlate("01R100AA");
    expect(sessions).toHaveLength(2);
    const fresh = sessions[1];
    expect(fresh.id).not.toBe(staleId);
    expect(fresh.status).toBe("active");
    expect(minutesSince(fresh.entered_at)).toBeLessThan(2);
  });

  it("2. active sessiya bo'lmasa hech narsa yopilmaydi, oddiy kirish davom etadi", async () => {
    const response = await postCameraEntry("01R200AA");
    expect(response.status).toBe(200);

    const sessions = await sessionsForPlate("01R200AA");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("active");
    expect(sessions[0].exit_method).toBeNull();
    expect(await autoCloseLogs()).toHaveLength(0);
  });

  it("3. avtomatik yopish activity log'ga to'liq diagnostika bilan yoziladi", async () => {
    const staleId = await createStaleActiveSession("01R300AA");
    const stale = await sessionById(staleId);
    await postCameraEntry("01R300AA");

    const logs = await autoCloseLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor_id: null,
      action: "session_auto_closed_on_reentry",
      target_type: "session",
      target_id: staleId,
    });
    expect(logs[0].details).toMatchObject({
      orgId,
      sessionId: staleId,
      plateNumber: "01R300AA",
      originalEnteredAt: new Date(stale.entered_at).toISOString(),
    });
    expect(logs[0].details.hoursOpen as number).toBeGreaterThan(STALE_HOURS - 1);
    expect(logs[0].details.hoursOpen as number).toBeLessThan(STALE_HOURS + 1);
  });

  it("4. qo'lda kirishda ham eski sessiya yopiladi va yangisi ochiladi", async () => {
    const staleId = await createStaleActiveSession("01R400AA");
    const response = await testRequest(server)
      .post("/api/parking/entry/manual")
      .set("Authorization", authHeader())
      .send({ plate_number: "01R400AA" });
    expect(response.status).toBe(201);

    const stale = await sessionById(staleId);
    expect(stale).toMatchObject({
      status: "completed",
      exit_method: "auto_closed_on_reentry",
      active_plate_key: null,
    });

    const sessions = await sessionsForPlate("01R400AA");
    expect(sessions).toHaveLength(2);
    expect(sessions[1].status).toBe("active");
    expect(minutesSince(sessions[1].entered_at)).toBeLessThan(2);
    expect(await autoCloseLogs()).toHaveLength(1);
  });

  it("5. chiqishda davomiylik va summa faqat yangi kirishdan hisoblanadi", async () => {
    const staleId = await createStaleActiveSession("01R500AA");
    await postCameraEntry("01R500AA");

    const exitResponse = await testRequest(server)
      .post("/api/parking/exit/manual")
      .set("Authorization", authHeader())
      .send({ plate_number: "01R500AA", payment_method: "cash" });
    expect(exitResponse.status).toBe(200);

    const sessions = await sessionsForPlate("01R500AA");
    expect(sessions).toHaveLength(2);
    const [stale, fresh] = sessions;

    expect(stale.id).toBe(staleId);
    expect(stale.duration_minutes).toBeGreaterThan(STALE_HOURS * 60 - 5);
    expect(Number(stale.amount)).toBe(0);

    expect(fresh.status).toBe("completed");
    expect(fresh.duration_minutes).toBeLessThan(5);
    expect(Number(fresh.amount)).toBeLessThanOrEqual(5000);

    const payments = await testDb("tb_payments").where({ session_id: fresh.id });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount)).toBe(Number(fresh.amount));
    expect(await testDb("tb_payments").where({ session_id: staleId })).toHaveLength(0);
  });

  it("6. bir belgi farqli plate eski sessiyani yopmaydi (faqat exact)", async () => {
    const staleId = await createStaleActiveSession("01R600AA");
    const response = await postCameraEntry("01R600AB");
    expect(response.status).toBe(200);

    const stale = await sessionById(staleId);
    expect(stale.status).toBe("active");
    expect(stale.exit_method).toBeNull();
    expect(stale.active_plate_key).not.toBeNull();

    expect(await sessionsForPlate("01R600AB")).toHaveLength(1);
    expect(await autoCloseLogs()).toHaveLength(0);
  });

  it("7. ketma-ket uch marta qayta kirishda har safar avvalgi sessiya yopiladi", async () => {
    await createStaleActiveSession("01R700AA");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expireWebhookDedupeWindow();
      const response = await postCameraEntry("01R700AA");
      expect(response.status).toBe(200);
    }

    const sessions = await sessionsForPlate("01R700AA");
    expect(sessions).toHaveLength(4);
    expect(sessions.slice(0, 3).map((session) => session.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(sessions.slice(0, 3).map((session) => session.exit_method)).toEqual([
      "auto_closed_on_reentry",
      "auto_closed_on_reentry",
      "auto_closed_on_reentry",
    ]);
    expect(sessions[3].status).toBe("active");
    expect(await autoCloseLogs()).toHaveLength(3);
    expect(await testDb("tb_payments").where({ org_id: orgId })).toHaveLength(0);
  });
});
