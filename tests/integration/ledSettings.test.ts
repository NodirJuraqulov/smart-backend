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
let superAdminUserId: number;
let owner: AuthTokenPayload;
let operator: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const superAdminUser = await createTestUser(null, { role: "super_admin" });
  superAdminUserId = superAdminUser.id;
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(otherOrgId);
  await cleanupOrganization(orgId);
  await db("tb_users").where({ id: superAdminUserId }).del();
});

afterAll(closeDb);

describe("organization LED settings", () => {
  it("owner va super admin o'qiydi, operator o'qiy olmaydi", async () => {
    const ownerResponse = await request(app)
      .get(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(owner));
    const superAdminResponse = await request(app)
      .get(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(superAdmin));
    const operatorResponse = await request(app)
      .get(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(operator));

    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body).toEqual({ led_host: null, led_port: null });
    expect(superAdminResponse.status).toBe(200);
    expect(superAdminResponse.body).toEqual({ led_host: null, led_port: null });
    expect(operatorResponse.status).toBe(403);
  });

  it("owner boshqa organization LED sozlamasini ko'rmaydi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${otherOrgId}/led-settings`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(404);
  });

  it("faqat super admin LED host va portni yangilaydi", async () => {
    const ownerResponse = await request(app)
      .patch(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(owner))
      .send({ led_host: "192.168.1.158", led_port: 10001 });
    const superAdminResponse = await request(app)
      .patch(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(superAdmin))
      .send({ led_host: "192.168.1.158", led_port: 10001 });

    expect(ownerResponse.status).toBe(403);
    expect(superAdminResponse.status).toBe(200);
    expect(superAdminResponse.body).toEqual({ led_host: "192.168.1.158", led_port: 10001 });
    const organization = await db("tb_organizations")
      .select("led_host", "led_port")
      .where({ id: orgId })
      .first();
    expect(organization).toMatchObject({ led_host: "192.168.1.158", led_port: 10001 });
  });

  it("host o'chirilganda host va portni null qiladi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({
      led_host: "192.168.1.158",
      led_port: 10001,
    });

    const response = await request(app)
      .patch(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(superAdmin))
      .send({ led_host: null });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ led_host: null, led_port: null });
  });

  it.each([
    { led_host: "http://192.168.1.157" },
    { led_host: "bad host" },
    { led_port: 0 },
    { led_port: 65536 },
    { led_port: 10.5 },
  ])("noto'g'ri LED sozlamasini rad etadi", async (body) => {
    const response = await request(app)
      .patch(`/api/organizations/${orgId}/led-settings`)
      .set("Authorization", authorization(superAdmin))
      .send(body);

    expect(response.status).toBe(400);
  });
});
