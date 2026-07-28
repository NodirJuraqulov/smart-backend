import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
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
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

let orgId: number;
let superAdmin: AuthTokenPayload;
let operator: AuthTokenPayload;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/organizations", organizationsRouter);
  app.use("/api/webhook", webhookRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
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

describe("GET /api/admin/organizations/:id/integration-settings", () => {
  it("to'g'ri qiymatlarni va to'liq webhook URL'larni qaytaradi", async () => {
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ webhook_token: "abc123token", camera_brand: "hikvision", printer_ip: "192.168.1.10" });

    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      printerIp: "192.168.1.10",
      cameraBrand: "hikvision",
      webhookToken: "abc123token",
    });
    expect(res.body.webhookEntryUrl).toMatch(/\/api\/webhook\/hikvision\/abc123token\/entry$/);
    expect(res.body.webhookExitUrl).toMatch(/\/api\/webhook\/hikvision\/abc123token\/exit$/);
  });

  it("operator/owner uchun 403 qaytaradi", async () => {
    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(403);
  });

  it("lastWebhookEntryAt/lastWebhookExitAt to'g'ri qiymatlar bilan qaytadi", async () => {
    const entryAt = new Date("2026-07-20T08:00:00Z");
    const exitAt = new Date("2026-07-20T09:00:00Z");
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ last_webhook_entry_at: entryAt, last_webhook_exit_at: exitAt });

    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(new Date(res.body.lastWebhookEntryAt)).toEqual(entryAt);
    expect(new Date(res.body.lastWebhookExitAt)).toEqual(exitAt);
  });

  it("hech qachon webhook kelmagan bo'lsa — null qaytadi", async () => {
    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.lastWebhookEntryAt).toBeNull();
    expect(res.body.lastWebhookExitAt).toBeNull();
  });
});

describe("Webhook qabul qilinganda last_webhook_*_at yangilanishi", () => {
  function buildHikvisionBody(plateNumber: string): { contentType: string; rawBody: Buffer } {
    const boundary = `Boundary${Math.random().toString(36).slice(2)}`;
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<EventNotificationAlert>" +
      "<dateTime>2026-07-25T10:00:00+05:00</dateTime>" +
      `<ANPR><licensePlate>${plateNumber}</licensePlate><confidenceLevel>92</confidenceLevel></ANPR>` +
      "</EventNotificationAlert>";
    const rawBody = Buffer.from(
      `--${boundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`
    );
    return { contentType: `multipart/form-data; boundary=${boundary}`, rawBody };
  }

  it("entry webhook kelganda last_webhook_entry_at yangilanadi, exit o'zgarmaydi", async () => {
    const webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });

    const { contentType, rawBody } = buildHikvisionBody("01L111AA");
    const res = await request(buildApp())
      .post(`/api/webhook/hikvision/${webhookToken}/entry`)
      .set("Content-Type", contentType)
      .send(rawBody);

    expect(res.status).toBe(200);

    const organization = await db("tb_organizations").where({ id: orgId }).first();
    expect(organization.last_webhook_entry_at).toBeTruthy();
    expect(organization.last_webhook_exit_at).toBeNull();
  });

  it("notanish formatda ham (candidate topilmasa ham) last_webhook_*_at yangilanadi", async () => {
    const webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });

    const res = await request(buildApp())
      .post(`/api/webhook/hikvision/${webhookToken}/exit`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("notanish format"));

    expect(res.status).toBe(200);

    const organization = await db("tb_organizations").where({ id: orgId }).first();
    expect(organization.last_webhook_exit_at).toBeTruthy();
  });
});

describe("PUT /api/admin/organizations/:id/integration-settings", () => {
  it("to'g'ri qiymatlarni saqlaydi", async () => {
    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin))
      .send({
        relay_entry_ip: "192.168.1.20",
        relay_exit_ip: "192.168.1.21",
        printer_ip: "192.168.1.22",
        camera_brand: "hikvision",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      relayEntryIp: "192.168.1.20",
      relayExitIp: "192.168.1.21",
      printerIp: "192.168.1.22",
      cameraBrand: "hikvision",
    });

    const organization = await db("tb_organizations").where({ id: orgId }).first();
    expect(organization.relay_entry_ip).toBe("192.168.1.20");
    expect(organization.printer_ip).toBe("192.168.1.22");
  });

  it("noto'g'ri IP format bilan 400 qaytaradi", async () => {
    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin))
      .send({ relay_entry_ip: "not-an-ip" });

    expect(res.status).toBe(400);
  });

  it("bo'sh string yuborilsa — null sifatida saqlanadi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ printer_ip: "192.168.1.30" });

    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin))
      .send({ printer_ip: "" });

    expect(res.status).toBe(200);
    expect(res.body.printerIp).toBeNull();
  });

  it("webhook_token'ni o'zgartirmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ webhook_token: "unchanged-token" });

    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin))
      .send({ printer_ip: "192.168.1.40" });

    expect(res.status).toBe(200);
    expect(res.body.webhookToken).toBe("unchanged-token");
  });

  it("operator/owner uchun 403 qaytaradi", async () => {
    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(operator))
      .send({ printer_ip: "192.168.1.50" });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/organizations/:id/integration-settings/regenerate-token", () => {
  it("yangi token generatsiya qiladi, eski token endi ishlamaydi", async () => {
    const oldToken = "old-webhook-token";
    await db("tb_organizations").where({ id: orgId }).update({ webhook_token: oldToken });

    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/integration-settings/regenerate-token`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.webhookToken).toBeTruthy();
    expect(res.body.webhookToken).not.toBe(oldToken);

    const organization = await db("tb_organizations").where({ id: orgId }).first();
    expect(organization.webhook_token).toBe(res.body.webhookToken);

    const oldTokenRes = await request(buildApp())
      .post(`/api/webhook/debug/${oldToken}/entry`)
      .send({});
    expect(oldTokenRes.status).toBe(404);

    const newTokenRes = await request(buildApp())
      .post(`/api/webhook/debug/${res.body.webhookToken}/entry`)
      .send({});
    expect(newTokenRes.status).toBe(200);
  });

  it("operator/owner uchun 403 qaytaradi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/integration-settings/regenerate-token`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(403);
  });
});
