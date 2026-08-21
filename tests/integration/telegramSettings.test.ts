import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import { decryptSecret } from "@/utils/encryption";
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
let owner: AuthTokenPayload;
let otherOwner: AuthTokenPayload;
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
  const otherOwnerUser = await createTestUser(otherOrgId, { role: "owner" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const superAdminUser = await createTestUser(null, { role: "super_admin" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  otherOwner = { id: otherOwnerUser.id, org_id: otherOrgId, role: "owner" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(otherOrgId);
  await cleanupOrganization(orgId);
  await db("tb_users").where({ id: superAdmin.id }).del();
});

afterAll(closeDb);

describe("organization Telegram settings", () => {
  it("GET tokenni qaytarmaydi va faqat Owner hamda Super Admin o'qiydi", async () => {
    const ownerResponse = await request(app)
      .get(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(owner));
    const superAdminResponse = await request(app)
      .get(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(superAdmin));
    const operatorResponse = await request(app)
      .get(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(operator));

    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body).toEqual({
      telegram_bot_configured: false,
      telegram_chat_ids: [],
    });
    expect(superAdminResponse.body).toEqual(ownerResponse.body);
    expect(operatorResponse.status).toBe(403);
    expect(ownerResponse.body).not.toHaveProperty("telegram_bot_token");
  });

  it("PATCH faqat Super Admin uchun ishlaydi, tokenni shifrlaydi va eski tokenni saqlaydi", async () => {
    const body = {
      telegram_bot_token: "123456789:TEST_bot-token",
      telegram_chat_ids: ["1652032889", "-987654321"],
    };
    const ownerResponse = await request(app)
      .patch(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(owner))
      .send(body);
    const superAdminResponse = await request(app)
      .patch(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(superAdmin))
      .send(body);

    expect(ownerResponse.status).toBe(403);
    expect(superAdminResponse.status).toBe(200);
    expect(superAdminResponse.body).toEqual({
      telegram_bot_configured: true,
      telegram_chat_ids: ["1652032889", "-987654321"],
    });
    expect(superAdminResponse.body).not.toHaveProperty("telegram_bot_token");

    const before = await db("tb_organizations")
      .select("telegram_bot_token")
      .where({ id: orgId })
      .first();
    expect(before.telegram_bot_token).not.toBe(body.telegram_bot_token);
    expect(decryptSecret(before.telegram_bot_token)).toBe(body.telegram_bot_token);

    const chatOnlyResponse = await request(app)
      .patch(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(superAdmin))
      .send({ telegram_chat_ids: ["777"] });
    const after = await db("tb_organizations")
      .select("telegram_bot_token")
      .where({ id: orgId })
      .first();

    expect(chatOnlyResponse.status).toBe(200);
    expect(chatOnlyResponse.body.telegram_chat_ids).toEqual(["777"]);
    expect(after.telegram_bot_token).toBe(before.telegram_bot_token);
  });

  it.each([
    { telegram_chat_ids: [] },
    { telegram_chat_ids: [""] },
    { telegram_chat_ids: ["chat"] },
    { telegram_chat_ids: ["12-34"] },
    { telegram_chat_ids: [123] },
    { telegram_chat_ids: "1652032889" },
  ])("telegram_chat_ids validatsiyasi noto'g'ri qiymatni rad etadi", async (body) => {
    const response = await request(app)
      .patch(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(superAdmin))
      .send(body);

    expect(response.status).toBe(400);
  });

  it("Owner boshqa organization sozlamasini ko'rmaydi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${orgId}/telegram-settings`)
      .set("Authorization", authorization(otherOwner));

    expect(response.status).toBe(404);
  });
});
