import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingRouter from "@/modules/parking/parking.routes";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

let orgId: number;
let otherOrgId: number;
let operator: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/parking", parkingRouter);
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
  otherOrgId = await createTestOrganization();
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/parking/sessions/:id/open-barrier", () => {
  it("operator o'z org'idagi sessiya uchun shlagbaumni ochadi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01C111AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/open-barrier`)
      .set("Authorization", authHeader(operator))
      .send({ direction: "entry" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "opened", success: true });
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
  });

  it("boshqa org'ga tegishli sessiya uchun 404 qaytaradi (scope tekshiruvi)", async () => {
    const foreignSessionId = await createTestActiveSession(otherOrgId, "01C222AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${foreignSessionId}/open-barrier`)
      .set("Authorization", authHeader(operator))
      .send({ direction: "entry" });

    expect(res.status).toBe(404);
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("noto'g'ri direction bilan 400 qaytaradi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01C333AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/open-barrier`)
      .set("Authorization", authHeader(operator))
      .send({ direction: "invalid" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/organizations/:id/relay/test", () => {
  it("super_admin uchun ishlaydi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/relay/test`)
      .set("Authorization", authHeader(superAdmin))
      .send({ direction: "exit" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "opened", success: true });
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
  });

  it("operator uchun 403 qaytaradi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/relay/test`)
      .set("Authorization", authHeader(operator))
      .send({ direction: "exit" });

    expect(res.status).toBe(403);
    expect(openBarrier).not.toHaveBeenCalled();
  });
});
