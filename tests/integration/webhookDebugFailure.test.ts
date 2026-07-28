import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { logWebhookDebug } from "@/modules/webhook/webhookDebugLog.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

vi.mock("@/modules/webhook/webhookDebugLog.service", () => ({
  logWebhookDebug: vi.fn(),
}));

let orgId: number;
let webhookToken: string;

function buildApp() {
  const app = express();
  app.use("/api/webhook", webhookRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/webhook/debug/:token/:direction — insert muvaffaqiyatsiz bo'lganda", () => {
  it("logWebhookDebug xato tashlasa — 200 QAYTARMAYDI", async () => {
    vi.mocked(logWebhookDebug).mockRejectedValueOnce(new Error("DB insert xatosi"));

    const res = await request(buildApp())
      .post(`/api/webhook/debug/${webhookToken}/entry`)
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
  });

  it("logWebhookDebug muvaffaqiyatli bo'lsa — 200 qaytaradi (regressiyasiz)", async () => {
    vi.mocked(logWebhookDebug).mockResolvedValueOnce(undefined);

    const res = await request(buildApp())
      .post(`/api/webhook/debug/${webhookToken}/entry`)
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });

    expect(res.status).toBe(200);
    expect(logWebhookDebug).toHaveBeenCalledTimes(1);
  });
});

describe("Kamera-yo'naltirilgan route'lar (hikvision/camera) — debug log xato bersa ham 200 qaytadi", () => {
  it("/hikvision/ — notanish payload + debug log xatosi bo'lsa ham 200 {parsed:false}", async () => {
    vi.mocked(logWebhookDebug).mockRejectedValueOnce(new Error("DB insert xatosi"));

    const res = await request(buildApp())
      .post(`/api/webhook/hikvision/${webhookToken}/entry`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("bu hikvision formatida emas"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: false });
    expect(logWebhookDebug).toHaveBeenCalledTimes(1);
  });

  it("/camera/ — notanish payload + debug log xatosi bo'lsa ham 200 {parsed:false}", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "hikvision" });
    vi.mocked(logWebhookDebug).mockRejectedValueOnce(new Error("DB insert xatosi"));

    const res = await request(buildApp())
      .post(`/api/webhook/camera/${webhookToken}/entry`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("bu hikvision formatida emas"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: false });
  });
});
