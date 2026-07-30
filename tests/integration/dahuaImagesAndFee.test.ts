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
import parkingRouter from "@/modules/parking/parking.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import webhookEventsRouter from "@/modules/webhook/webhookEvents.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { openBarrier } from "@/modules/relay/relay.service";
import { emitPlateNotRecognizedForExit } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "disabled", success: false }),
}));
vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

let OVERVIEW_JPEG: Buffer;
let CUTOUT_JPEG: Buffer;
let PLATE_JPEG: Buffer;
let JPEG_BASE64: string;
let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let server: http.Server;

function authHeader(value = actor): string {
  return `Bearer ${signAccessToken(value)}`;
}

const VEHICLE_BOUNDING_BOX = [40, 40, 360, 280];

function dahuaPayload(plateNumber: string) {
  return {
    Picture: {
      NormalPic: { Content: `data:image/jpeg;base64,${JPEG_BASE64}`, PicName: "../../unsafe.jpg" },
      CutoutPic: { Content: CUTOUT_JPEG.toString("base64"), PicName: "../../../cutout.jpg" },
      PlatePic: { Content: PLATE_JPEG.toString("base64"), PicName: "/tmp/plate.jpg" },
    },
    Plate: { IsExist: true, PlateNumber: plateNumber },
    Vehicle: { VehicleBoundingBox: VEHICLE_BOUNDING_BOX },
    SnapInfo: { DeviceID: "dahua-1", SnapTime: "2026-07-28 17:56:00", LanNo: 1 },
  };
}

async function postCamera(direction: "entry" | "exit", body: unknown) {
  return request(server)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function expectValidJpeg(absolutePath: string): Promise<{ width: number; height: number }> {
  const buffer = await fs.readFile(absolutePath);
  const metadata = await sharp(buffer).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBeGreaterThan(0);
  expect(metadata.height).toBeGreaterThan(0);
  return { width: metadata.width!, height: metadata.height! };
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/webhook-events", webhookEventsRouter);
  app.use("/api/parking", parkingRouter);
  app.use(errorHandler);
  server = http.createServer(app);

  OVERVIEW_JPEG = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#666" } })
    .jpeg()
    .toBuffer();
  CUTOUT_JPEG = await sharp({ create: { width: 96, height: 32, channels: 3, background: "#333" } })
    .jpeg()
    .toBuffer();
  PLATE_JPEG = await sharp({ create: { width: 60, height: 20, channels: 3, background: "#111" } })
    .jpeg()
    .toBuffer();
  JPEG_BASE64 = OVERVIEW_JPEG.toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  webhookToken = `dahua-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken, camera_brand: "dahua" });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const user = await createTestUser(orgId, { role: "operator" });
  actor = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await clearWebhookDedupeCache();
  await fs.rm(path.join(process.cwd(), "uploads", "parking", String(orgId)), { recursive: true, force: true });
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), { recursive: true, force: true });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("Dahua rasmlari va exit hisobi", () => {
  it("entry rasmlarini org/session papkasiga yozadi va API URL qaytaradi", async () => {
    const response = await postCamera("entry", dahuaPayload("50M093BB"));
    expect(response.body).toMatchObject({ ok: true, parsed: true, plate_number: "50M093BB" });

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "50M093BB" }).first();
    expect(session.entry_vehicle_image_path).toContain(`uploads/parking/${orgId}/`);
    expect(session.entry_plate_image_path).toContain(`uploads/parking/${orgId}/`);
    expect(session.entry_vehicle_image_path).not.toContain("..");
    const { width, height } = await expectValidJpeg(path.resolve(session.entry_vehicle_image_path));
    expect(width).toBeLessThanOrEqual(400);
    expect(height).toBeLessThanOrEqual(300);
    expect(await fs.readFile(path.resolve(session.entry_plate_image_path))).toEqual(PLATE_JPEG);

    const detail = await request(server)
      .get(`/api/parking/sessions/${session.id}`)
      .set("Authorization", authHeader());
    expect(detail.body.session.entryVehicleImageUrl).toContain(
      `/api/parking/sessions/${session.id}/images/entry-vehicle`
    );
    expect(detail.body.session.entryPlateImageUrl).toContain(
      `/api/parking/sessions/${session.id}/images/entry-plate`
    );
    expect(JSON.stringify(detail.body)).not.toContain(JPEG_BASE64);
  });

  it("exit rasmlarini shu sessiyaga biriktiradi va 61 daqiqani 2 soat tarifida hisoblaydi", async () => {
    await postCamera("entry", dahuaPayload("50M094BB"));
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "50M094BB" }).first();
    await db("tb_parking_sessions")
      .where({ id: session.id })
      .update({ entered_at: new Date(Date.now() - 61 * 60 * 1000) });
    await clearWebhookDedupeCache();

    await postCamera("exit", dahuaPayload("50M094BB"));
    const exited = await db("tb_parking_sessions").where({ id: session.id }).first();
    expect(exited.status).toBe("awaiting_payment");
    expect(exited.duration_minutes).toBeGreaterThanOrEqual(61);
    expect(Number(exited.amount)).toBe(10000);
    expect(exited.exit_vehicle_image_path).toContain(`uploads/parking/${orgId}/`);
    expect(exited.exit_plate_image_path).toContain(`uploads/parking/${orgId}/`);

    const awaiting = await request(server)
      .get("/api/parking/sessions/awaiting-payment")
      .set("Authorization", authHeader());
    expect(awaiting.body.sessions[0]).toMatchObject({
      id: session.id,
      status: "awaiting_payment",
      exitVehicleImageUrl: expect.any(String),
      exitPlateImageUrl: expect.any(String),
    });
  });

  it("media endpoint boshqa tashkilot foydalanuvchisiga rasm bermaydi", async () => {
    await postCamera("entry", dahuaPayload("50M095BB"));
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "50M095BB" }).first();
    const otherUser = await createTestUser(otherOrgId, { role: "operator" });
    const foreignActor: AuthTokenPayload = { id: otherUser.id, org_id: otherOrgId, role: "operator" };

    const own = await request(server)
      .get(`/api/parking/sessions/${session.id}/images/entry-vehicle`)
      .set("Authorization", authHeader());
    expect(own.status).toBe(200);
    expect(own.headers["content-type"]).toBe("image/jpeg");

    const foreign = await request(server)
      .get(`/api/parking/sessions/${session.id}/images/entry-vehicle`)
      .set("Authorization", authHeader(foreignActor));
    expect(foreign.status).toBe(404);
  });

  it("rasmsiz va yaroqsiz rasmli ANPR ham sessiya yaratadi", async () => {
    const noImage = { Plate: { IsExist: true, PlateNumber: "50M096BB" }, SnapInfo: { DeviceID: "dahua-1" } };
    expect((await postCamera("entry", noImage)).body.parsed).toBe(true);
    await clearWebhookDedupeCache();
    const invalid = {
      Picture: { NormalPic: { Content: "not-base64", PicName: "x.jpg" } },
      Plate: { IsExist: true, PlateNumber: "50M097BB" },
    };
    expect((await postCamera("entry", invalid)).body.parsed).toBe(true);
    const [{ count }] = await db("tb_parking_sessions")
      .where({ org_id: orgId })
      .count<{ count: string }[]>("id as count");
    expect(Number(count)).toBe(2);
  });

  it("event rasmlari webhook event ID bo'yicha uch xil faylda saqlanadi", async () => {
    await postCamera("entry", dahuaPayload("50M098BB"));
    const event = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "50M098BB" })
      .first();

    expect(event.overview_image_path).toMatch(
      new RegExp(`^uploads/parking-events/${orgId}/\\d{4}/\\d{2}/\\d{2}/${event.id}/overview\\.jpg$`)
    );
    expect(event.vehicle_image_path).toContain(`/${event.id}/vehicle.jpg`);
    expect(event.plate_image_path).toContain(`/${event.id}/plate.jpg`);
    expect(await fs.readFile(path.resolve(event.overview_image_path))).toEqual(OVERVIEW_JPEG);
    await expectValidJpeg(path.resolve(event.vehicle_image_path));
    expect(await fs.readFile(path.resolve(event.plate_image_path))).toEqual(PLATE_JPEG);
    expect(event.image_processing_result).toBe("saved");
  });

  it("no-plate exit audit va rasmlarni saqlaydi, session/relay/paymentga tegmaydi", async () => {
    vi.clearAllMocks();
    const payload = dahuaPayload("IGNORED");
    payload.Plate = { IsExist: false, PlateNumber: "" };

    const response = await postCamera("exit", payload);

    expect(response.body).toMatchObject({
      parsed: true,
      ignored: true,
      reason: "plate_not_recognized",
      plate_number: null,
    });
    const event = await db("tb_webhook_events").where({ org_id: orgId }).first();
    expect(event).toMatchObject({
      plate_number: null,
      processing_result: "plate_not_recognized",
      processing_reason: "camera_ocr_failed",
      image_processing_result: "saved",
      session_id: null,
    });
    expect(event.overview_image_path).toContain(`/${event.id}/overview.jpg`);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitPlateNotRecognizedForExit).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: null, eventId: event.id })
    );
    const [{ sessionCount }] = await db("tb_parking_sessions")
      .where({ org_id: orgId })
      .count<{ sessionCount: string }[]>("id as sessionCount");
    const [{ paymentCount }] = await db("tb_payments")
      .where({ org_id: orgId })
      .count<{ paymentCount: string }[]>("id as paymentCount");
    expect(Number(sessionCount)).toBe(0);
    expect(Number(paymentCount)).toBe(0);
  });

  it("unmatched exit rasmlarini session bo'lmasa ham saqlaydi", async () => {
    await postCamera("exit", dahuaPayload("50M099BB"));
    const event = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "50M099BB" })
      .first();
    expect(event.processing_result).toBe("unmatched_exit");
    expect(event.session_id).toBeNull();
    expect(event.vehicle_image_path).toContain(`/${event.id}/vehicle.jpg`);
  });

  it("duplicate event yangi rasm nusxalarini saqlamaydi", async () => {
    await postCamera("entry", dahuaPayload("50M100BB"));
    await postCamera("entry", dahuaPayload("50M100BB"));
    const events = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "50M100BB" })
      .orderBy("id");
    expect(events).toHaveLength(2);
    expect(events[0].vehicle_image_path).toContain(`/${events[0].id}/vehicle.jpg`);
    expect(events[1]).toMatchObject({
      processing_result: "duplicate_same_direction",
      image_processing_result: "skipped",
      image_processing_reason: "duplicate_skipped",
      overview_image_path: null,
      vehicle_image_path: null,
      plate_image_path: null,
    });
  });

  it("har event alohida katalog ishlatadi va boshqa event faylini overwrite qilmaydi", async () => {
    await postCamera("entry", dahuaPayload("50M101BB"));
    await postCamera("entry", dahuaPayload("50M102BB"));
    const events = await db("tb_webhook_events").where({ org_id: orgId }).orderBy("id");
    expect(events).toHaveLength(2);
    expect(events[0].vehicle_image_path).not.toBe(events[1].vehicle_image_path);
    expect(events[0].vehicle_image_path).toContain(`/${events[0].id}/`);
    expect(events[1].vehicle_image_path).toContain(`/${events[1].id}/`);
    await expectValidJpeg(path.resolve(events[0].vehicle_image_path));
  });

  it("event image endpoint auth va organization isolationni saqlaydi", async () => {
    await postCamera("entry", dahuaPayload("50M103BB"));
    const event = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "50M103BB" })
      .first();
    const otherUser = await createTestUser(otherOrgId, { role: "operator" });
    const foreignActor: AuthTokenPayload = { id: otherUser.id, org_id: otherOrgId, role: "operator" };

    expect((await request(server).get(`/api/webhook-events/${event.id}/images/vehicle`)).status).toBe(401);
    const own = await request(server)
      .get(`/api/webhook-events/${event.id}/images/vehicle`)
      .set("Authorization", authHeader());
    expect(own.status).toBe(200);
    expect(own.headers["content-type"]).toBe("image/jpeg");
    const foreign = await request(server)
      .get(`/api/webhook-events/${event.id}/images/vehicle`)
      .set("Authorization", authHeader(foreignActor));
    expect(foreign.status).toBe(404);
  });

  it("DB path traversal event image endpoint orqali chiqmaydi", async () => {
    await postCamera("entry", dahuaPayload("50M104BB"));
    const event = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "50M104BB" })
      .first();
    await db("tb_webhook_events")
      .where({ id: event.id })
      .update({ vehicle_image_path: "uploads/parking-events/../../etc/passwd" });

    const response = await request(server)
      .get(`/api/webhook-events/${event.id}/images/vehicle`)
      .set("Authorization", authHeader());
    expect(response.status).toBe(404);
  });
});
