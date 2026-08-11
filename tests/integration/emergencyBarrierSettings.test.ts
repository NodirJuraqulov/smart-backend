import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import cameraRelaySettingsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

interface ActivityLogRow {
  action: string;
  target_id: number;
  details: Record<string, unknown>;
}

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let operator: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

const app = express();
app.use(express.json());
app.use("/api/organizations", cameraRelaySettingsRouter);
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;

function auth(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function getSettings(actor: AuthTokenPayload, targetOrgId = orgId) {
  return testRequest(app)
    .get(`/api/organizations/${targetOrgId}/emergency-barrier-settings`)
    .set("Authorization", auth(actor));
}

async function patchSettings(
  actor: AuthTokenPayload,
  body: Record<string, unknown>,
  targetOrgId = orgId
) {
  return testRequest(app)
    .patch(`/api/organizations/${targetOrgId}/emergency-barrier-settings`)
    .set("Authorization", auth(actor))
    .send(body);
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  await createTestTariff(orgId);
  await createTestTariff(otherOrgId);

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };

  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };

  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await testDb("tb_users").whereNull("org_id").del();
});

afterAll(closeDb);

describe("favqulodda shlagbaum tugmasi sozlamasi", () => {
  it("1. default holatda true qaytadi", async () => {
    const response = await getSettings(owner);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ emergency_barrier_button_enabled: true });

    const row = await testDb("tb_organizations").where({ id: orgId }).first();
    expect(!!row.emergency_barrier_button_enabled).toBe(true);
  });

  it("2. owner false qilib saqlaydi, GET false qaytaradi", async () => {
    const updated = await patchSettings(owner, { emergency_barrier_button_enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ emergency_barrier_button_enabled: false });

    const response = await getSettings(owner);
    expect(response.body).toEqual({ emergency_barrier_button_enabled: false });

    const operatorView = await getSettings(operator);
    expect(operatorView.status).toBe(200);
    expect(operatorView.body).toEqual({ emergency_barrier_button_enabled: false });

    const back = await patchSettings(superAdmin, { emergency_barrier_button_enabled: true });
    expect(back.body).toEqual({ emergency_barrier_button_enabled: true });
  });

  it("3. operator sozlamani o'zgartira olmaydi (403)", async () => {
    const response = await patchSettings(operator, { emergency_barrier_button_enabled: false });
    expect(response.status).toBe(403);

    const row = await testDb("tb_organizations").where({ id: orgId }).first();
    expect(!!row.emergency_barrier_button_enabled).toBe(true);
  });

  it("4. boshqa organization sozlamasiga kirib bo'lmaydi", async () => {
    expect((await getSettings(owner, otherOrgId)).status).toBe(404);
    expect(
      (await patchSettings(owner, { emergency_barrier_button_enabled: false }, otherOrgId)).status
    ).toBe(404);

    const untouched = await testDb("tb_organizations").where({ id: otherOrgId }).first();
    expect(!!untouched.emergency_barrier_button_enabled).toBe(true);
  });

  it("5. noto'g'ri qiymat 400 qaytaradi va audit yoziladi", async () => {
    expect((await patchSettings(owner, {})).status).toBe(400);
    expect((await patchSettings(owner, { emergency_barrier_button_enabled: "yes" })).status).toBe(400);

    const row = await testDb("tb_organizations").where({ id: orgId }).first();
    expect(!!row.emergency_barrier_button_enabled).toBe(true);

    await patchSettings(owner, { emergency_barrier_button_enabled: false });
    const audit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "organization.emergency_barrier_button_updated", target_id: orgId })
      .first();
    expect(audit).toBeTruthy();
    expect(audit!.details).toMatchObject({ orgId, emergencyBarrierButtonEnabled: false });
  });
});
