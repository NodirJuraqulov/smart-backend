import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/organizations", organizationsRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let operator: AuthTokenPayload;
let owner: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function authorization(actor: AuthTokenPayload) {
  return `Bearer ${signAccessToken(actor)}`;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  await db("tb_organizations").where({ id: orgId }).update({ gate_layout: "shared" });
  await db("tb_organizations").where({ id: otherOrgId }).update({ gate_layout: "separate" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const superAdminUser = await createTestUser(null, { role: "super_admin" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(otherOrgId);
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("GET /api/organizations/:id/gate-layout", () => {
  it("operator o'z organization gate_layout qiymatini o'qiy oladi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${orgId}/gate-layout`)
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ gate_layout: "shared" });
  });

  it("owner o'z organization gate_layout qiymatini o'qiy oladi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${orgId}/gate-layout`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ gate_layout: "shared" });
  });

  it("super admin gate_layout qiymatini o'qiy oladi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${orgId}/gate-layout`)
      .set("Authorization", authorization(superAdmin));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ gate_layout: "shared" });
  });

  it("boshqa organization gate_layout qiymatini yashiradi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${otherOrgId}/gate-layout`)
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Stoyanka topilmadi" });
  });

  it("autentifikatsiyasiz so'rovni rad etadi", async () => {
    const response = await request(app).get(`/api/organizations/${orgId}/gate-layout`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: "Token topilmadi" });
  });
});
