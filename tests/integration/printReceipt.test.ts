import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingRouter from "@/modules/parking/parking.routes";
import { printReceipt } from "@/modules/printer/printer.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/printer/printer.service", () => ({
  printReceipt: vi.fn().mockResolvedValue(true),
}));

let orgId: number;
let otherOrgId: number;
let operator: AuthTokenPayload;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/parking", parkingRouter);
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
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/parking/sessions/:id/print-receipt", () => {
  it("printer_ip sozlangan bo'lsa — chek chop etadi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ printer_ip: "192.168.1.70" });
    const sessionId = await createTestActiveSession(orgId, "01D111AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/print-receipt`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(printReceipt).toHaveBeenCalledWith(
      "192.168.1.70",
      expect.objectContaining({ plateNumber: "01D111AA" })
    );
  });

  it("printer_ip sozlanmagan bo'lsa — printer_not_configured qaytaradi, printReceipt chaqirilmaydi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01D222AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/print-receipt`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, reason: "printer_not_configured" });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it("boshqa org'ga tegishli sessiya uchun 404 qaytaradi (scope tekshiruvi)", async () => {
    await db("tb_organizations").where({ id: otherOrgId }).update({ printer_ip: "192.168.1.80" });
    const foreignSessionId = await createTestActiveSession(otherOrgId, "01D333AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${foreignSessionId}/print-receipt`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(404);
    expect(printReceipt).not.toHaveBeenCalled();
  });
});
