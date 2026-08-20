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
import entryCandidatesRouter from "@/modules/entryCandidates/entryCandidates.routes";
import parkingSessionsEntryBarrierRouter from "@/modules/entryCandidates/parkingSessionsEntryBarrier.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
  setOrgCapacity,
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
  org_id: number;
  plate_number: string;
  status: string;
}

let server: http.Server;
let orgId: number;
let owner: AuthTokenPayload;
let webhookToken: string;
let jpegBase64: string;

const testDb: typeof db = db;
const testRequest: typeof request = request;

function auth(): string {
  return `Bearer ${signAccessToken(owner)}`;
}

function dahuaBody(plate: string) {
  return {
    Picture: { NormalPic: { Content: jpegBase64, PicName: `${plate}.jpg` } },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 90 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "fuzzy-entry-camera", SnapTime: new Date().toISOString() },
  };
}

async function postEntry(plate: string) {
  return testRequest(server)
    .post(`/api/webhook/camera/${webhookToken}/entry`)
    .set("Content-Type", "application/json")
    .send(dahuaBody(plate));
}

async function manualEntry(plate: string) {
  return testRequest(server)
    .post("/api/parking-sessions/manual-entry")
    .set("Authorization", auth())
    .send({ plate_number: plate, reason: "Kamera o'qimadi" });
}

async function recentSession(plate: string, secondsAgo: number): Promise<number> {
  return createTestActiveSession(orgId, plate, new Date(Date.now() - secondsAgo * 1000));
}

async function sessions(): Promise<SessionRow[]> {
  return testDb<SessionRow>("tb_parking_sessions").where({ org_id: orgId }).orderBy("id", "asc");
}

async function latestEvent() {
  return testDb("tb_webhook_events").where({ org_id: orgId }).orderBy("id", "desc").first();
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/entry-candidates", entryCandidatesRouter);
  app.use("/api/parking-sessions", parkingSessionsEntryBarrierRouter);
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
  webhookToken = `fuzzyentry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await testDb("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestSettings(orgId, { work_hours_enabled: false });
  await setOrgCapacity(orgId, 20);
  const user = await createTestUser(orgId, { role: "owner" });
  owner = { id: user.id, org_id: orgId, role: "owner" };
  vi.mocked(openBarrier).mockReset().mockResolvedValue({ status: "opened", success: true, detail: "opened" });
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
  vi.clearAllMocks();
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("kirishda fuzzy dublikat aniqlash", () => {
  it("1. bir belgi farqli raqam yangi sessiya yaratmaydi", async () => {
    const existingId = await recentSession("01M616PC", 10);

    const response = await postEntry("D1M616PC");
    expect(response.status).toBe(200);
    expect(response.body.reason).toBe("fuzzy_duplicate_entry_ignored");

    const all = await sessions();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(existingId);

    expect(await testDb("tb_entry_candidates").where({ org_id: orgId })).toHaveLength(0);
    expect(await latestEvent()).toMatchObject({
      processing_result: "fuzzy_duplicate_entry_ignored",
      processing_reason: "fuzzy_active_session_match",
      session_id: existingId,
    });
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("2. yaqin sessiya bo'lmasa odatdagi kirish oqimi davom etadi", async () => {
    await recentSession("01M616PC", 10);

    const response = await postEntry("77XYZ999");
    expect(response.status).toBe(200);
    expect(response.body.reason).toBeUndefined();

    const all = await sessions();
    expect(all).toHaveLength(2);
    expect(all.map((session) => session.plate_number)).toContain("77XYZ999");
    expect(await latestEvent()).toMatchObject({ processing_result: "entry_created" });
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
  });

  it("3. bir nechta yaqin nomzod bo'lsa hech qaysi tanlanmaydi", async () => {
    await recentSession("01M616PC", 10);
    await recentSession("01M616PD", 10);

    const response = await postEntry("01M616PX");
    expect(response.status).toBe(200);
    expect(response.body.reason).toBeUndefined();

    const all = await sessions();
    expect(all).toHaveLength(3);
    expect(all.map((session) => session.plate_number)).toContain("01M616PX");
  });

  it("4. 6 belgidan qisqa raqamlarda fuzzy qo'llanilmaydi", async () => {
    await recentSession("01A1B", 10);

    const response = await postEntry("01A1C");
    expect(response.status).toBe(200);
    expect(response.body.reason).toBeUndefined();

    const all = await sessions();
    expect(all).toHaveLength(2);
    expect(all.map((session) => session.plate_number).sort()).toEqual(["01A1B", "01A1C"]);
  });

  it("5. qo'lda kiritishda ham fuzzy dublikat bloklanadi", async () => {
    const existingId = await recentSession("01M616PC", 10);

    const response = await manualEntry("D1M616PC");
    expect(response.status).toBe(409);
    expect(response.body.message).toBe("Bu mashina hali stoyankada!");

    const all = await sessions();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(existingId);
  });

  it("6. qo'lda kiritishda yaqin bo'lmagan raqam muammosiz o'tadi", async () => {
    await recentSession("01M616PC", 10);

    const response = await manualEntry("55QWE111");
    expect(response.status).toBe(200);

    const all = await sessions();
    expect(all).toHaveLength(2);
    expect(all.map((session) => session.plate_number)).toContain("55QWE111");
  });

  it("8. 35 soniya oldin kirgan fuzzy nomzod bloklamaydi", async () => {
    const oldId = await recentSession("01M616PC", 35);

    const response = await postEntry("D1M616PC");
    expect(response.status).toBe(200);
    expect(response.body.reason).toBeUndefined();

    const all = await sessions();
    expect(all).toHaveLength(2);
    expect(all.map((session) => session.plate_number)).toContain("D1M616PC");
    expect((await sessions()).find((session) => session.id === oldId)?.status).toBe("active");
  });

  it("9. 30 soniyalik oyna chegarasi: 29 soniya bloklaydi, 31 soniya bloklamaydi", async () => {
    await recentSession("01M616PC", 29);
    const inside = await postEntry("D1M616PC");
    expect(inside.body.reason).toBe("fuzzy_duplicate_entry_ignored");
    expect(await sessions()).toHaveLength(1);

    await clearWebhookDedupeCache(orgId);
    await testDb("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01M616PC" })
      .update({ entered_at: new Date(Date.now() - 31 * 1000) });

    const outside = await postEntry("D1M616PC");
    expect(outside.body.reason).toBeUndefined();
    expect(await sessions()).toHaveLength(2);
  });

  it("10. qo'lda kiritishda ham 30 soniyadan eski nomzod bloklamaydi", async () => {
    await recentSession("01M616PC", 35);

    const response = await manualEntry("D1M616PC");
    expect(response.status).toBe(200);

    const all = await sessions();
    expect(all).toHaveLength(2);
    expect(all.map((session) => session.plate_number)).toContain("D1M616PC");
  });

  it("7. entry/manual endpointi ham fuzzy dublikatni rad etadi", async () => {
    await recentSession("01M616PC", 10);

    const response = await testRequest(server)
      .post("/api/parking/entry/manual")
      .set("Authorization", auth())
      .send({ plate_number: "D1M616PC" });
    expect(response.status).toBe(409);

    expect(await sessions()).toHaveLength(1);
  });
});
