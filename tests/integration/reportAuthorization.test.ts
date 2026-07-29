import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import reportsRouter from "@/modules/reports/reports.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
  seedTestOperatorPermissions,
} from "./helpers";

let orgId: number;
let otherOrgId: number;
let operatorId: number;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/reports", reportsRouter);
  instance.use(errorHandler);
  return instance;
}

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function setPermissions(dashboard: boolean, reports: boolean): Promise<void> {
  await db("tb_operator_permissions")
    .where({ org_id: orgId, section_key: "dashboard" })
    .update({ can_view: dashboard });
  await db("tb_operator_permissions")
    .where({ org_id: orgId, section_key: "reports" })
    .update({ can_view: reports });
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  await seedTestOperatorPermissions(orgId);
  const operator = await createTestUser(orgId, { role: "operator" });
  operatorId = operator.id;
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("report route authorization", () => {
  it("dashboard-only operator faqat joriy kunni va faqat o'z tashkiloti ma'lumotini ko'radi", async () => {
    await setPermissions(true, false);
    await db("tb_parking_sessions").insert([
      {
        org_id: orgId,
        plate_number: "01OWN001",
        entered_at: new Date(),
        status: "active",
        entry_method: "manual",
      },
      {
        org_id: otherOrgId,
        plate_number: "01OTHER1",
        entered_at: new Date(),
        status: "active",
        entry_method: "manual",
      },
    ]);
    const actor: AuthTokenPayload = { id: operatorId, org_id: orgId, role: "operator" };

    const response = await request(app())
      .get("/api/reports/daily")
      .set("Authorization", authorization(actor));

    expect(response.status).toBe(200);
    expect(response.body.org_id).toBe(orgId);
    expect(response.body.total_entries).toBe(1);
  });

  it.each([
    "/api/reports/daily?date=2026-07-01",
    "/api/reports/daily?from_date=2026-07-01&to_date=2026-07-03",
    "/api/reports/daily?year=2026",
    "/api/reports/monthly",
    "/api/reports/yearly",
  ])("dashboard-only operator uchun tarixiy query 403: %s", async (path) => {
    await setPermissions(true, false);
    const actor: AuthTokenPayload = { id: operatorId, org_id: orgId, role: "operator" };

    const response = await request(app()).get(path).set("Authorization", authorization(actor));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: "Ruxsat yo'q — bu bo'limga kirish cheklangan" });
  });

  it.each([
    "/api/reports/daily",
    "/api/reports/daily?date=2026-07-01",
    "/api/reports/daily?from_date=2026-07-01&to_date=2026-07-03",
    "/api/reports/monthly",
    "/api/reports/yearly",
  ])("reports permission operator uchun ruxsat beradi: %s", async (path) => {
    await setPermissions(false, true);
    const actor: AuthTokenPayload = { id: operatorId, org_id: orgId, role: "operator" };

    const response = await request(app()).get(path).set("Authorization", authorization(actor));

    expect(response.status).toBe(200);
  });

  it("dashboard va reports permission bo'lmagan operatorga 403 qaytaradi", async () => {
    await setPermissions(false, false);
    const actor: AuthTokenPayload = { id: operatorId, org_id: orgId, role: "operator" };

    const response = await request(app())
      .get("/api/reports/daily")
      .set("Authorization", authorization(actor));

    expect(response.status).toBe(403);
  });

  it("owner uchun barcha report endpointlari ochiq qoladi", async () => {
    await setPermissions(false, false);
    const owner = await createTestUser(orgId, { role: "owner" });
    const actor: AuthTokenPayload = { id: owner.id, org_id: orgId, role: "owner" };

    for (const path of ["/api/reports/daily?date=2026-07-01", "/api/reports/monthly", "/api/reports/yearly"]) {
      const response = await request(app()).get(path).set("Authorization", authorization(actor));
      expect(response.status).toBe(200);
    }
  });

  it("Super Admin mavjud org_id qoidasi bilan barcha report endpointlariga kira oladi", async () => {
    const admin = await createTestUser(null, { role: "super_admin" });
    const actor: AuthTokenPayload = { id: admin.id, org_id: null, role: "super_admin" };

    try {
      for (const path of [
        `/api/reports/daily?org_id=${orgId}`,
        `/api/reports/monthly?org_id=${orgId}`,
        `/api/reports/yearly?org_id=${orgId}`,
      ]) {
        const response = await request(app()).get(path).set("Authorization", authorization(actor));
        expect(response.status).toBe(200);
        expect(response.body.org_id).toBe(orgId);
      }
    } finally {
      await db("tb_users").where({ id: admin.id }).del();
    }
  });
});
