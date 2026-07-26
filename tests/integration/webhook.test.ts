import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

let orgId: number;
let webhookToken: string;

function buildApp() {
  const app = express();
  app.use("/api/webhook", webhookRouter);
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
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/webhook/debug/:token/:direction", () => {
  it("har qanday body bilan 200 qaytaradi va tb_webhook_debug_logs ga yozadi", async () => {
    const res = await request(buildApp())
      .post(`/api/webhook/debug/${webhookToken}/entry`)
      .set("Content-Type", "application/json")
      .send({ foo: "bar", nested: { a: 1 } });

    expect(res.status).toBe(200);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    expect(log).toBeTruthy();
    expect(log.headers).toBeTruthy();
    expect(log.body).toBeTruthy();
  });

  it("noto'g'ri token bilan 404 qaytaradi", async () => {
    const res = await request(buildApp())
      .post("/api/webhook/debug/notogri-token/entry")
      .send({});

    expect(res.status).toBe(404);
  });

  it("bloklangan tashkilot uchun ham 404 qaytaradi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ is_active: false });

    const res = await request(buildApp()).post(`/api/webhook/debug/${webhookToken}/entry`).send({});

    expect(res.status).toBe(404);
  });
});

describe("POST /api/webhook/hikvision/:token/:direction", () => {
  it("to'g'ri Hikvision multipart formatini parse qiladi", async () => {
    const boundary = "TestBoundary123";
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<EventNotificationAlert>" +
      "<dateTime>2026-07-25T10:00:00+05:00</dateTime>" +
      "<ANPR><licensePlate>01A123AA</licensePlate><confidenceLevel>92</confidenceLevel></ANPR>" +
      "</EventNotificationAlert>";
    const rawBody = Buffer.from(
      `--${boundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`
    );

    const res = await request(buildApp())
      .post(`/api/webhook/hikvision/${webhookToken}/entry`)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: true, plate_number: "01A123AA", confidence: 92 });

    const logs = await db("tb_webhook_debug_logs").where({ org_id: orgId });
    expect(logs).toHaveLength(0);
  });

  it("notanish formatni parse qilmaydi va tb_webhook_debug_logs ga yozadi", async () => {
    const res = await request(buildApp())
      .post(`/api/webhook/hikvision/${webhookToken}/exit`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("bu hikvision formatida emas"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: false });

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "exit" });
    expect(log).toBeTruthy();
  });

  it("noto'g'ri token bilan 404 qaytaradi", async () => {
    const res = await request(buildApp())
      .post("/api/webhook/hikvision/notogri-token/entry")
      .send(Buffer.from("data"));

    expect(res.status).toBe(404);
  });
});
