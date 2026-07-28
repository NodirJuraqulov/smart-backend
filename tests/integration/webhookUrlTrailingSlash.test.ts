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
    env: { ...actual.env, publicBaseUrl: actual.stripTrailingSlashes("http://195.158.9.168:84/") },
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
    .update({ webhook_token: "slashtoken456", camera_brand: "hikvision" });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("PUBLIC_BASE_URL oxirida / bilan berilganda", () => {
  it("webhookEntryUrl/webhookExitUrl'da double slash chiqmaydi", async () => {
    const res = await request(buildApp())
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.webhookEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/hikvision/slashtoken456/entry"
    );
    expect(res.body.webhookEntryUrl).not.toMatch(/84\/\/api/);
    expect(res.body.webhookDebugEntryUrl).toBe(
      "http://195.158.9.168:84/api/webhook/debug/slashtoken456/entry"
    );
    expect(res.body.webhookDebugEntryUrl).not.toMatch(/84\/\/api/);
  });
});
