import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import { printReceipt } from "@/modules/printer/printer.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization, createTestUser } from "./helpers";

vi.mock("@/modules/printer/printer.service", () => ({
  printReceipt: vi.fn().mockResolvedValue(true),
}));

let orgId: number;
let superAdmin: AuthTokenPayload;
let operator: AuthTokenPayload;

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

describe("POST /api/admin/organizations/:id/printer/test", () => {
  it("printer sozlangan bo'lsa — sinov chek chiqaradi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ printer_ip: "192.168.1.99" });

    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/printer/test`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(printReceipt).toHaveBeenCalledWith(
      "192.168.1.99",
      expect.objectContaining({
        orgName: "Sinov chek",
        plateNumber: "TEST123",
        amount: 0,
        paymentMethod: "cash",
      })
    );
  });

  it("printer sozlanmagan bo'lsa — printer_not_configured qaytaradi, printReceipt chaqirilmaydi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/printer/test`)
      .set("Authorization", authHeader(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, reason: "printer_not_configured" });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it("operator uchun 403 qaytaradi", async () => {
    const res = await request(buildApp())
      .post(`/api/admin/organizations/${orgId}/printer/test`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(403);
    expect(printReceipt).not.toHaveBeenCalled();
  });
});
