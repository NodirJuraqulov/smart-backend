import { promises as fs } from "fs";
import http from "http";
import path from "path";
import express from "express";
import request from "supertest";
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

const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let server: http.Server;

function authHeader(value = actor): string {
  return `Bearer ${signAccessToken(value)}`;
}

function dahuaPayload(plateNumber: string) {
  return {
    Picture: {
      NormalPic: { Content: `data:image/jpeg;base64,${JPEG_BASE64}`, PicName: "../../unsafe.jpg" },
      PlatePic: { Content: JPEG_BASE64, PicName: "/tmp/plate.jpg" },
    },
    Plate: { IsExist: true, PlateNumber: plateNumber },
    SnapInfo: { DeviceID: "dahua-1", SnapTime: "2026-07-28 17:56:00", LanNo: 1 },
  };
}

async function postCamera(direction: "entry" | "exit", body: unknown) {
  return request(server)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(body);
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(express.json());
  app.use("/api/parking", parkingRouter);
  app.use(errorHandler);
  server = http.createServer(app);
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
    expect(await fs.readFile(path.resolve(session.entry_vehicle_image_path))).toEqual(
      Buffer.from(JPEG_BASE64, "base64")
    );

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
});
