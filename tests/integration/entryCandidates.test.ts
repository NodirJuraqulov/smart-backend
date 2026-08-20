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
import cameraRelaySettingsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import {
  emitEntryBarrierFailed,
  emitEntryCandidateCreated,
  emitEntryCandidateResolved,
  emitEntryCompleted,
} from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestActiveSession,
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

let server: http.Server;
let orgId: number;
let otherOrgId: number;
let token: string;
let owner: AuthTokenPayload;
let jpegBase64: string;

interface EntryCandidateRow {
  id: number;
  org_id: number;
  detected_plate: string | null;
  status: string;
}

interface EntrySessionRow {
  id: number;
  org_id: number;
  plate_number: string;
  status: string;
}

interface CameraRelayPasswordRow {
  id: number;
  entry_camera_relay_password_encrypted: string | null;
}

const testDb: typeof db = db;
const testRequest: typeof request = request;

function buildDahuaBody(plate: string) {
  return {
    Picture: { NormalPic: { Content: jpegBase64, PicName: `${plate}.jpg` } },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 93 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "entry-candidate-camera", SnapTime: new Date().toISOString() },
  };
}

function authHeader(actor = owner): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function postEntry(plate: string) {
  return request(server)
    .post(`/api/webhook/camera/${token}/entry`)
    .set("Content-Type", "application/json")
    .send(buildDahuaBody(plate));
}

async function pendingCandidate(): Promise<EntryCandidateRow> {
  const candidate = await testDb<EntryCandidateRow>("tb_entry_candidates")
    .where({ org_id: orgId, status: "pending" })
    .first();
  if (!candidate) throw new Error("Pending entry candidate topilmadi");
  return candidate;
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/entry-candidates", entryCandidatesRouter);
  app.use("/api/parking-sessions", parkingSessionsEntryBarrierRouter);
  app.use("/api/organizations", cameraRelaySettingsRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  jpegBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  token = `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: token,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId);
  await createTestTariff(otherOrgId);
  const user = await createTestUser(orgId, { role: "owner" });
  owner = { id: user.id, org_id: orgId, role: "owner" };
  vi.mocked(openBarrier).mockReset().mockResolvedValue({ status: "opened", success: true, detail: "opened" });
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
  await cleanupOrganization(otherOrgId);
  await clearWebhookDedupeCache(orgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("entry capacity va candidate workflow", () => {
  it("joy bor entry sessiya yaratadi, relay va entry_completed yuboradi", async () => {
    await setOrgCapacity(orgId, 2);
    const response = await postEntry("01E100AA");
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01E100AA" }).first();
    expect(response.status).toBe(200);
    expect(session.status).toBe("active");
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
    expect(emitEntryCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ sessionId: session.id, barrierStatus: "opened" })
    );
  });

  it("relay failed bo'lsa sessiya saqlanadi, audit va entry_barrier_failed yuboriladi", async () => {
    await setOrgCapacity(orgId, 2);
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false, detail: "timeout" });
    await postEntry("01E101AA");
    const session = await testDb<EntrySessionRow>("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01E101AA" })
      .first();
    if (!session) throw new Error("Entry session topilmadi");
    const audit = await testDb("tb_activity_logs")
      .where({ target_type: "session", target_id: session.id, action: "parking.entry_barrier_open_failed" })
      .first();
    expect(session.status).toBe("active");
    expect(audit).toBeTruthy();
    expect(emitEntryBarrierFailed).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ sessionId: session.id, detail: "timeout" })
    );
  });

  it("parking to'lsa sessiyasiz pending candidate yaratadi va relay chaqirmaydi", async () => {
    await setOrgCapacity(orgId, 0);
    await postEntry("01E102AA");
    const candidate: EntryCandidateRow = await pendingCandidate();
    expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeUndefined();
    expect(candidate).toMatchObject({ detected_plate: "01E102AA", status: "pending" });
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitEntryCandidateCreated).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ candidateId: candidate.id, detectedPlate: "01E102AA" })
    );
  });

  it("accept capacityni qayta tekshirmasdan sessiya va audit yaratib relayni ochadi", async () => {
    await setOrgCapacity(orgId, 0);
    await postEntry("01E103AA");
    const candidate = await pendingCandidate();
    const response = await testRequest(server)
      .post(`/api/entry-candidates/${candidate.id}/accept`)
      .set("Authorization", authHeader())
      .send({ plate_number: "01E103AA" });
    const session = await db("tb_parking_sessions").where({ id: response.body.session_id }).first();
    const resolved = await db("tb_entry_candidates").where({ id: candidate.id }).first();
    const audit = await db("tb_activity_logs")
      .where({ action: "parking.entry_candidate_accepted", target_id: candidate.id })
      .first();
    expect(response.status).toBe(200);
    expect(session.status).toBe("active");
    expect(resolved).toMatchObject({ status: "accepted", resolved_session_id: session.id });
    expect(audit).toBeTruthy();
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
    expect(emitEntryCandidateResolved).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ candidateId: candidate.id, status: "accepted", sessionId: session.id })
    );
  });

  it("acceptdan keyingi relay failed session va accepted candidate'ni rollback qilmaydi", async () => {
    await setOrgCapacity(orgId, 0);
    await postEntry("01E104AA");
    const candidate = await pendingCandidate();
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false, detail: "connection refused" });
    const response = await request(server)
      .post(`/api/entry-candidates/${candidate.id}/accept`)
      .set("Authorization", authHeader())
      .send({ plate_number: "01E104AA" });
    expect(response.body.barrier_status).toBe("failed");
    expect(await db("tb_parking_sessions").where({ id: response.body.session_id, status: "active" }).first()).toBeTruthy();
    expect(await db("tb_entry_candidates").where({ id: candidate.id, status: "accepted" }).first()).toBeTruthy();
  });

  it("decline sessiya va relay yaratmaydi, candidate va auditni yangilaydi", async () => {
    await setOrgCapacity(orgId, 0);
    await postEntry("01E105AA");
    const candidate: EntryCandidateRow = await pendingCandidate();
    const response = await testRequest(server)
      .post(`/api/entry-candidates/${candidate.id}/decline`)
      .set("Authorization", authHeader())
      .send({ note: "Joy berilmadi" });
    expect(response.status).toBe(200);
    expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeUndefined();
    expect(await db("tb_entry_candidates").where({ id: candidate.id }).first()).toMatchObject({
      status: "declined",
      note: "Joy berilmadi",
    });
    expect(
      await db("tb_activity_logs")
        .where({ action: "parking.entry_candidate_declined", target_id: candidate.id })
        .first()
    ).toBeTruthy();
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("hal qilingan candidate ikkinchi accept yoki decline uchun 409 qaytaradi", async () => {
    await setOrgCapacity(orgId, 0);
    await postEntry("01E106AA");
    const candidate: EntryCandidateRow = await pendingCandidate();
    await request(server)
      .post(`/api/entry-candidates/${candidate.id}/decline`)
      .set("Authorization", authHeader())
      .send({});
    expect(
      (await request(server)
        .post(`/api/entry-candidates/${candidate.id}/accept`)
        .set("Authorization", authHeader())
        .send({ plate_number: "01E106AA" })).status
    ).toBe(409);
    expect(
      (await request(server).post(`/api/entry-candidates/${candidate.id}/decline`).set("Authorization", authHeader()).send({})).status
    ).toBe(409);
  });

  it("retry entry barrier faqat eng oxirgi failed auditdan keyin ishlaydi", async () => {
    await setOrgCapacity(orgId, 2);
    vi.mocked(openBarrier)
      .mockResolvedValueOnce({ status: "failed", success: false, detail: "timeout" })
      .mockResolvedValueOnce({ status: "opened", success: true, detail: "opened" });
    await postEntry("01E107AA");
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01E107AA" }).first();
    const response = await request(server)
      .post(`/api/parking-sessions/${session.id}/retry-entry-barrier`)
      .set("Authorization", authHeader())
      .send({});
    expect(response.body).toEqual({ barrier_status: "opened" });
    expect(openBarrier).toHaveBeenCalledTimes(2);
    expect(
      (await request(server)
        .post(`/api/parking-sessions/${session.id}/retry-entry-barrier`)
        .set("Authorization", authHeader())
        .send({})).status
    ).toBe(400);
  });

  it("boshqa organization candidate va sessionlariga kirishni bloklaydi", async () => {
    const foreignToken = `foreign-${Date.now()}`;
    await db("tb_organizations").where({ id: otherOrgId }).update({
      webhook_token: foreignToken,
      total_capacity: 0,
      camera_brand: "dahua",
    });
    const oldToken = token;
    token = foreignToken;
    await postEntry("01E108AA");
    token = oldToken;
    const candidate = await db("tb_entry_candidates").where({ org_id: otherOrgId }).first();
    const response = await request(server)
      .post(`/api/entry-candidates/${candidate.id}/accept`)
      .set("Authorization", authHeader())
      .send({ plate_number: "01E108AA" });
    expect(response.status).toBe(404);
    const foreignSessionId = await createTestActiveSession(otherOrgId, "01E108BB");
    const retryResponse = await request(server)
      .post(`/api/parking-sessions/${foreignSessionId}/retry-entry-barrier`)
      .set("Authorization", authHeader())
      .send({});
    expect(retryResponse.status).toBe(404);
  });

  it("next bo'sh holatda 204, pending bo'lsa eng eski candidate bilan 200 qaytaradi", async () => {
    expect((await request(server).get("/api/entry-candidates/next").set("Authorization", authHeader())).status).toBe(204);
    await setOrgCapacity(orgId, 0);
    await postEntry("01E109AA");
    const response = await request(server).get("/api/entry-candidates/next").set("Authorization", authHeader());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      detected_plate: "01E109AA",
      pending_count_for_org: 1,
      entry_images: {
        overview_url: expect.any(String),
        vehicle_url: null,
        image_available: true,
      },
    });
  });
});

describe("camera relay settings", () => {
  it("GET parolni hech qachon qaytarmaydi", async () => {
    const response = await request(server)
      .get(`/api/organizations/${orgId}/camera-relay-settings`)
      .set("Authorization", authHeader());
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("password");
  });

  it("PATCH password yuborilmasa eski shifrlangan qiymatni saqlaydi", async () => {
    const first = await request(server)
      .patch(`/api/organizations/${orgId}/camera-relay-settings`)
      .set("Authorization", authHeader())
      .send({ entry: { host: "192.168.1.10", port: 80, username: "admin", password: "secret", channel: 1 } });
    expect(first.status).toBe(200);
    const before = await testDb<CameraRelayPasswordRow>("tb_organizations")
      .select("entry_camera_relay_password_encrypted")
      .where({ id: orgId })
      .first();
    const second = await request(server)
      .patch(`/api/organizations/${orgId}/camera-relay-settings`)
      .set("Authorization", authHeader())
      .send({ entry: { host: "192.168.1.11", port: 8080, username: "admin2", channel: 2 } });
    const after = await testDb<CameraRelayPasswordRow>("tb_organizations")
      .select("entry_camera_relay_password_encrypted")
      .where({ id: orgId })
      .first();
    if (!before || !after) throw new Error("Camera relay sozlamalari topilmadi");
    expect(second.status).toBe(200);
    expect(after.entry_camera_relay_password_encrypted).toBe(before.entry_camera_relay_password_encrypted);
    expect(second.body.entry).toMatchObject({ configured: true, host: "192.168.1.11", port: 8080, username: "admin2", channel: 2 });
  });
});
