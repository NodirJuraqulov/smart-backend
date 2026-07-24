import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "@/middleware/errorHandler";
import tariffIntervalsSelfRouter from "@/modules/tariffIntervals/tariffIntervalsSelf.routes";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariffInterval,
  createTestUser,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;
let owner: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tariff-intervals", tariffIntervalsSelfRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

describe("GET/POST /api/tariff-intervals — operator/owner o'z org'i uchun", () => {
  it("operator o'z org'i uchun interval yarata va ro'yxatini ko'ra oladi", async () => {
    const app = buildApp();

    const created = await request(app)
      .post("/api/tariff-intervals")
      .set("Authorization", authHeader(operator))
      .send({ from_minutes: 5, to_minutes: 60, price: 10000 });
    expect(created.status).toBe(201);
    expect(created.body.interval.org_id).toBe(orgId);

    const listed = await request(app)
      .get("/api/tariff-intervals")
      .set("Authorization", authHeader(operator));
    expect(listed.status).toBe(200);
    expect(listed.body.intervals).toHaveLength(1);
  });

  it("owner o'z org'i uchun interval yarata oladi", async () => {
    const app = buildApp();

    const created = await request(app)
      .post("/api/tariff-intervals")
      .set("Authorization", authHeader(owner))
      .send({ from_minutes: 5, to_minutes: 60, price: 10000 });
    expect(created.status).toBe(201);
    expect(created.body.interval.org_id).toBe(orgId);
  });

  it("super_admin bu route'ga kira olmaydi — 403", async () => {
    const adminUser = await createTestUser(null, { role: "super_admin" });
    const superAdmin: AuthTokenPayload = { id: adminUser.id, org_id: null, role: "super_admin" };
    const app = buildApp();

    const res = await request(app).get("/api/tariff-intervals").set("Authorization", authHeader(superAdmin));
    expect(res.status).toBe(403);
  });
});

describe("PUT/DELETE /api/tariff-intervals/:intervalId — scope", () => {
  it("operator o'z org'ining interval'ini tahrirlay oladi", async () => {
    const intervalId = await createTestTariffInterval(orgId, { price: 10000 });
    const app = buildApp();

    const res = await request(app)
      .put(`/api/tariff-intervals/${intervalId}`)
      .set("Authorization", authHeader(operator))
      .send({ price: 15000 });
    expect(res.status).toBe(200);
    expect(Number(res.body.interval.price)).toBe(15000);
  });

  it("owner o'z org'ining interval'ini o'chira oladi", async () => {
    const intervalId = await createTestTariffInterval(orgId);
    const app = buildApp();

    const res = await request(app)
      .delete(`/api/tariff-intervals/${intervalId}`)
      .set("Authorization", authHeader(owner));
    expect(res.status).toBe(204);
  });

  it("boshqa org'ning interval'ini tahrirlashga urinsa — 404 (scope)", async () => {
    const otherOrgId = await createTestOrganization();
    try {
      const otherIntervalId = await createTestTariffInterval(otherOrgId, { price: 20000 });
      const app = buildApp();

      const res = await request(app)
        .put(`/api/tariff-intervals/${otherIntervalId}`)
        .set("Authorization", authHeader(operator))
        .send({ price: 1 });
      expect(res.status).toBe(404);
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });

  it("boshqa org'ning interval'ini o'chirishga urinsa — 404 (scope)", async () => {
    const otherOrgId = await createTestOrganization();
    try {
      const otherIntervalId = await createTestTariffInterval(otherOrgId);
      const app = buildApp();

      const res = await request(app)
        .delete(`/api/tariff-intervals/${otherIntervalId}`)
        .set("Authorization", authHeader(owner));
      expect(res.status).toBe(404);
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });
});
