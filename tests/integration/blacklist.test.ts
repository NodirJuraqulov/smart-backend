import { promises as fs } from "fs";
import http from "http";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import blacklistRouter from "@/modules/blacklist/blacklist.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { emitBlacklistAttempt } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
  createTestVipVehicle,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

vi.mock("@/websocket/socketServer", () => ({
  emitBlacklistAttempt: vi.fn(),
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

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/organizations", blacklistRouter);
app.use(errorHandler);

let server: http.Server;
let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let imageBase64: string;
let owner: AuthTokenPayload;
let otherOwner: AuthTokenPayload;
let operator: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function cameraBody(plateNumber: string, timestamp = new Date()) {
  return {
    Picture: {
      NormalPic: { Content: imageBase64, PicName: `${plateNumber}-${timestamp.getTime()}.jpg` },
    },
    Plate: { IsExist: true, PlateNumber: plateNumber, Confidence: 95 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "blacklist-camera", SnapTime: timestamp.toISOString() },
  };
}

function postWebhook(direction: "entry" | "exit", plateNumber: string, timestamp = new Date()) {
  return request(server)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(cameraBody(plateNumber, timestamp));
}

async function insertBlacklist(targetOrgId: number, plateNumber: string, createdBy: number): Promise<number> {
  const [id] = await db("tb_blacklisted_vehicles").insert({
    org_id: targetOrgId,
    plate_number: plateNumber,
    reason: "Test blok",
    created_by: createdBy,
  });
  return id;
}

async function ageLatestEntryWebhook(): Promise<void> {
  const event = await db("tb_webhook_events")
    .select("id")
    .where({ org_id: orgId, direction: "entry" })
    .orderBy("id", "desc")
    .first();
  if (!event) throw new Error("Entry webhook topilmadi");
  await db("tb_webhook_events")
    .where({ id: event.id, org_id: orgId })
    .update({ created_at: db.raw("NOW() - INTERVAL 11 SECOND") });
}

beforeAll(async () => {
  await assertTestDatabase();
  server = http.createServer(app);
  imageBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#333" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `blacklist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestTariff(otherOrgId, { price_per_hour: 5000, grace_period_minutes: 0 });

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  const otherOwnerUser = await createTestUser(otherOrgId, { role: "owner" });
  otherOwner = { id: otherOwnerUser.id, org_id: otherOrgId, role: "owner" };
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  const superAdminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };

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
  await db("tb_users").where({ id: superAdmin.id }).del();
});

afterAll(async () => {
  server?.close();
  await closeDb();
});

describe("Qora ro'yxat", () => {
  it("1. qora ro'yxatdagi mashina uchun shlagbaum ochilmaydi, session va candidate yaratilmaydi", async () => {
    await insertBlacklist(orgId, "01B100AA", owner.id);

    const response = await postWebhook("entry", "01B100AA");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ blocked: true, reason: "blacklisted", plate_number: "01B100AA" });
    expect(await db("tb_parking_sessions").where({ org_id: orgId })).toHaveLength(0);
    expect(await db("tb_entry_candidates").where({ org_id: orgId })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();
    const event = await db("tb_webhook_events").where({ org_id: orgId }).orderBy("id", "desc").first();
    expect(event).toMatchObject({ processing_result: "entry_blacklisted", processing_reason: "blacklist_match" });
  });

  it("2. blacklist attempt plate, kamera vaqti va mavjud rasm URL bilan yoziladi", async () => {
    await insertBlacklist(orgId, "01B200AA", owner.id);
    const cameraTime = new Date();

    await postWebhook("entry", "01B200AA", cameraTime);

    const attempt = await db("tb_blacklist_attempts").where({ org_id: orgId }).first();
    expect(attempt).toMatchObject({ plate_number: "01B200AA", direction: "entry" });
    expect(Math.abs(new Date(attempt.attempted_at).getTime() - cameraTime.getTime())).toBeLessThan(1000);
    expect(attempt.image_url).toMatch(/^\/api\/webhook-events\/\d+\/images\/overview$/);

    const response = await request(app)
      .get(`/api/organizations/${orgId}/blacklist-attempts?page=1&limit=10`)
      .set("Authorization", authorization(owner));
    expect(response.status).toBe(200);
    expect(response.body.attempts).toHaveLength(1);
    expect(response.body.pagination).toEqual({ page: 1, limit: 10, total: 1, total_pages: 1 });
  });

  it("bir xil mashinaning 30 soniya ichidagi uchta signali bitta attempt va bitta socket event yaratadi", async () => {
    await insertBlacklist(orgId, "01B210AA", owner.id);
    const firstTime = new Date(Date.now() - 20_000);

    const first = await postWebhook("entry", "01B210AA", firstTime);
    await ageLatestEntryWebhook();
    const second = await postWebhook("entry", "01B210AA", new Date(firstTime.getTime() + 10_000));
    await ageLatestEntryWebhook();
    const third = await postWebhook("entry", "01B210AA", new Date(firstTime.getTime() + 20_000));

    expect([first.body, second.body, third.body].map((body) => body.blocked)).toEqual([true, true, true]);
    expect([first.body, second.body, third.body].map((body) => body.attempt_created)).toEqual([
      true,
      false,
      false,
    ]);
    expect(await db("tb_blacklist_attempts").where({ org_id: orgId, plate_number: "01B210AA" })).toHaveLength(1);
    expect(emitBlacklistAttempt).toHaveBeenCalledTimes(1);
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("bir xil mashinaning 30 soniyadan uzoq ikki signali ikkita attempt va socket event yaratadi", async () => {
    await insertBlacklist(orgId, "01B220AA", owner.id);
    const firstTime = new Date(Date.now() - 40_000);

    const first = await postWebhook("entry", "01B220AA", firstTime);
    await ageLatestEntryWebhook();
    const second = await postWebhook("entry", "01B220AA", new Date());

    expect(first.body).toMatchObject({ blocked: true, attempt_created: true });
    expect(second.body).toMatchObject({ blocked: true, attempt_created: true });
    expect(await db("tb_blacklist_attempts").where({ org_id: orgId, plate_number: "01B220AA" })).toHaveLength(2);
    expect(emitBlacklistAttempt).toHaveBeenCalledTimes(2);
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("3. qora ro'yxatda bo'lmagan mashina odatdagi entry oqimida davom etadi", async () => {
    const response = await postWebhook("entry", "01B300AA");

    expect(response.status).toBe(200);
    expect(response.body.reason).not.toBe("blacklisted");
    expect(await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01B300AA" })).toHaveLength(1);
    expect(await db("tb_blacklist_attempts").where({ org_id: orgId })).toHaveLength(0);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
  });

  it("4. ham VIP ham qora ro'yxatdagi mashinada qora ro'yxat ustun turadi", async () => {
    await createTestVipVehicle(orgId, "01B400AA");
    await insertBlacklist(orgId, "01B400AA", owner.id);

    const response = await postWebhook("entry", "01B400AA");

    expect(response.body).toMatchObject({ blocked: true, reason: "blacklisted" });
    expect(await db("tb_parking_sessions").where({ org_id: orgId })).toHaveLength(0);
    expect(await db("tb_entry_candidates").where({ org_id: orgId })).toHaveLength(0);
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("5. Owner va Super Admin CRUD qiladi, Operator barcha blacklist endpointlarida 403 oladi", async () => {
    const created = await request(app)
      .post(`/api/organizations/${orgId}/blacklist`)
      .set("Authorization", authorization(owner))
      .send({ plate_number: "01 b 500 aa", reason: "Xavfsizlik" });
    expect(created.status).toBe(201);
    expect(created.body.vehicle).toMatchObject({
      org_id: orgId,
      plate_number: "01B500AA",
      reason: "Xavfsizlik",
      created_by: owner.id,
    });

    const ownerList = await request(app)
      .get(`/api/organizations/${orgId}/blacklist`)
      .set("Authorization", authorization(owner));
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.vehicles).toHaveLength(1);

    const adminList = await request(app)
      .get(`/api/organizations/${orgId}/blacklist`)
      .set("Authorization", authorization(superAdmin));
    expect(adminList.status).toBe(200);
    expect(adminList.body.vehicles).toHaveLength(1);

    const operatorResponses = await Promise.all([
      request(app).get(`/api/organizations/${orgId}/blacklist`).set("Authorization", authorization(operator)),
      request(app)
        .post(`/api/organizations/${orgId}/blacklist`)
        .set("Authorization", authorization(operator))
        .send({ plate_number: "01B501AA" }),
      request(app)
        .delete(`/api/organizations/${orgId}/blacklist/${created.body.vehicle.id}`)
        .set("Authorization", authorization(operator)),
      request(app)
        .get(`/api/organizations/${orgId}/blacklist-attempts`)
        .set("Authorization", authorization(operator)),
    ]);
    expect(operatorResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);

    const deleted = await request(app)
      .delete(`/api/organizations/${orgId}/blacklist/${created.body.vehicle.id}`)
      .set("Authorization", authorization(owner));
    expect(deleted.status).toBe(204);
    expect(await db("tb_blacklisted_vehicles").where({ org_id: orgId })).toHaveLength(0);
  });

  it("6. Owner boshqa organization va uning blacklist yozuviga 404 oladi", async () => {
    const otherId = await insertBlacklist(otherOrgId, "01B600AA", otherOwner.id);

    const foreignList = await request(app)
      .get(`/api/organizations/${otherOrgId}/blacklist`)
      .set("Authorization", authorization(owner));
    const foreignDelete = await request(app)
      .delete(`/api/organizations/${orgId}/blacklist/${otherId}`)
      .set("Authorization", authorization(owner));
    const foreignCreate = await request(app)
      .post(`/api/organizations/${otherOrgId}/blacklist`)
      .set("Authorization", authorization(owner))
      .send({ plate_number: "01B601AA" });
    const foreignAttempts = await request(app)
      .get(`/api/organizations/${otherOrgId}/blacklist-attempts`)
      .set("Authorization", authorization(owner));

    expect(foreignList.status).toBe(404);
    expect(foreignDelete.status).toBe(404);
    expect(foreignCreate.status).toBe(404);
    expect(foreignAttempts.status).toBe(404);
    expect(await db("tb_blacklisted_vehicles").where({ id: otherId })).toHaveLength(1);
  });

  it("7. blacklist_attempt WebSocket eventi plate, vaqt va rasm URL bilan yuboriladi", async () => {
    await insertBlacklist(orgId, "01B700AA", owner.id);

    await postWebhook("entry", "01B700AA");

    expect(emitBlacklistAttempt).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        attemptId: expect.any(Number),
        orgId,
        plateNumber: "01B700AA",
        attemptedAt: expect.any(String),
        imageUrl: expect.stringMatching(/^\/api\/webhook-events\/\d+\/images\/overview$/),
      })
    );
  });

  it("8. qora ro'yxat exit webhook oqimiga ta'sir qilmaydi", async () => {
    await insertBlacklist(orgId, "01B800AA", owner.id);

    const response = await postWebhook("exit", "01B800AA");

    expect(response.status).toBe(200);
    expect(response.body.reason).not.toBe("blacklisted");
    expect(await db("tb_blacklist_attempts").where({ org_id: orgId })).toHaveLength(0);
    expect(await db("tb_exit_candidates").where({ org_id: orgId, detected_plate: "01B800AA" })).toHaveLength(1);
  });
});
