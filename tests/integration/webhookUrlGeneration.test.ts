import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

vi.mock("@/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env")>();
  return {
    ...actual,
    env: { ...actual.env, publicBaseUrl: "http://195.158.9.168:84" },
  };
});

let orgId: number;
let superAdmin: AuthTokenPayload;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/organizations", organizationsRouter);
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
  await db("tb_organizations")
    .where({ id: orgId })
    .update({ webhook_token: "fixedtoken123", camera_brand: "hikvision" });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("Webhook URL generatsiyasi — PUBLIC_BASE_URL asosida", () => {
  it("GET integration-settings — tashqi port saqlanib qoladi", async () => {
    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.webhookEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/hikvision/fixedtoken123/entry"
    );
    expect(res.body.webhookExitUrl).toBe(
      "http://195.158.9.168:84/api/webhook/hikvision/fixedtoken123/exit"
    );
    expect(res.body.webhookDebugEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/fixedtoken123/entry"
    );
    expect(res.body.webhookDebugExitUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/fixedtoken123/exit"
    );
  });

  it("PUT integration-settings javobida ham to'g'ri URL qaytadi", async () => {
    const res = await request(buildApp())
      .put(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin))
      .send({ printer_ip: "192.168.1.50" });

    expect(res.status).toBe(200);
    expect(res.body.webhookEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/hikvision/fixedtoken123/entry"
    );
    expect(res.body.webhookDebugEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/fixedtoken123/entry"
    );
    expect(res.body.webhookDebugExitUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/fixedtoken123/exit"
    );
  });

  it("token regeneratsiyasidan keyin yangi token bilan to'g'ri URL qaytadi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/integration-settings/regenerate-token`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.webhookToken).not.toBe("fixedtoken123");
    expect(res.body.webhookEntryUrl).toBe(
      `http://195.158.9.168:84/api/webhook/hikvision/${res.body.webhookToken}/entry`
    );
    expect(res.body.webhookExitUrl).toBe(
      `http://195.158.9.168:84/api/webhook/hikvision/${res.body.webhookToken}/exit`
    );
    expect(res.body.webhookDebugEntryUrl).toBe(
      `http://195.158.9.168:84/api/webhook/debug/${res.body.webhookToken}/entry`
    );
    expect(res.body.webhookDebugExitUrl).toBe(
      `http://195.158.9.168:84/api/webhook/debug/${res.body.webhookToken}/exit`
    );
  });

  it("Dahua kabi kelajakdagi kamera brendi uchun ham to'g'ri URL quriladi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ camera_brand: "dahua" });

    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.webhookEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/dahua/fixedtoken123/entry"
    );
    expect(res.body.webhookDebugEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/fixedtoken123/entry"
    );
  });
});
