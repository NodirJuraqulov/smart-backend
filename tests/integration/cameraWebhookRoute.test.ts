import http from "http";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { emitEntryDetected, emitExitAwaitingPayment, emitWebhookParseFailed } from "@/websocket/socketServer";
import { cameraParserFactory } from "@/modules/webhook/parsers/cameraParserFactory";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
} from "./helpers";

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue(true),
}));

let orgId: number;
let webhookToken: string;
let server: http.Server;

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

async function postToRoute(
  route: "hikvision" | "camera" | "debug",
  direction: "entry" | "exit",
  plateNumber: string
) {
  const { contentType, rawBody } = buildHikvisionBody(plateNumber);
  return request(server)
    .post(`/api/webhook/${route}/${webhookToken}/${direction}`)
    .set("Content-Type", contentType)
    .send(rawBody);
}

async function activeSessionCount(): Promise<number> {
  const [{ count }] = await db("tb_parking_sessions")
    .where({ org_id: orgId, status: "active" })
    .count<{ count: string }[]>("id as count");
  return Number(count);
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  server = http.createServer(app);
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
  await clearWebhookDedupeCache();
});

afterAll(async () => {
  server?.close();
  await closeDb();
});

describe("POST /api/webhook/camera/:token/:direction — organization.camera_brand asosida", () => {
  it("camera_brand='hikvision' bo'lsa — Hikvision parser bilan sessiya yaratiladi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "hikvision" });

    const res = await postToRoute("camera", "entry", "01C111AA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: true, plate_number: "01C111AA" });
    expect(await activeSessionCount()).toBe(1);
    expect(emitEntryDetected).toHaveBeenCalledWith(orgId, expect.objectContaining({ plateNumber: "01C111AA" }));
  });

  it("camera_brand bo'sh/null bo'lsa — standart hikvision'ga tushadi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: null });

    const res = await postToRoute("camera", "entry", "01C222AA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: true, plate_number: "01C222AA" });
    expect(await activeSessionCount()).toBe(1);
  });

  it("camera_brand='dahua' bo'lsa — Dahua skeleti ishga tushadi, parsed:false qaytadi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "dahua" });

    const res = await postToRoute("camera", "entry", "01C333AA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: false });
    expect(await activeSessionCount()).toBe(0);
    expect(emitWebhookParseFailed).toHaveBeenCalledWith(orgId, expect.objectContaining({ direction: "entry" }));
  });

  it("noma'lum camera_brand bo'lsa — 400 qaytadi, sessiya yaratilmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "sony" });

    const res = await postToRoute("camera", "entry", "01C444AA");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Unsupported camera brand: sony");
    expect(await activeSessionCount()).toBe(0);
  });

  it("camera_brand case-insensitive ishlaydi ('HIKVISION')", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "HIKVISION" });

    const res = await postToRoute("camera", "entry", "01C555AA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: true, plate_number: "01C555AA" });
  });
});

describe("POST /api/webhook/hikvision/:token/:direction — eski route buzilmagan", () => {
  it("camera_brand nima bo'lishidan qat'iy nazar Hikvision parser ishlaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "dahua" });

    const res = await postToRoute("hikvision", "entry", "01C666AA");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: true, plate_number: "01C666AA" });
    expect(await activeSessionCount()).toBe(1);
  });
});

describe("POST /api/webhook/debug/:token/:direction — parser factoryga kirmaydi", () => {
  it("getParser hech qachon chaqirilmaydi", async () => {
    const getParserSpy = vi.spyOn(cameraParserFactory, "getParser");

    const res = await postToRoute("debug", "entry", "01C777AA");

    expect(res.status).toBe(200);
    expect(getParserSpy).not.toHaveBeenCalled();

    getParserSpy.mockRestore();
  });
});

describe("Entry/exit biznes logikasi — normalized event orqali avvalgidek ishlaydi", () => {
  it("exit — awaiting_payment holatiga to'g'ri o'tadi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "hikvision" });

    await postToRoute("camera", "entry", "01C888AA");
    await clearWebhookDedupeCache();

    const res = await postToRoute("camera", "exit", "01C888AA");

    expect(res.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01C888AA" }).first();
    expect(session.status).toBe("awaiting_payment");
    expect(emitExitAwaitingPayment).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01C888AA" })
    );
  });
});
