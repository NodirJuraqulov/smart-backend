import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingRouter from "@/modules/parking/parking.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import { printReceipt } from "@/modules/printer/printer.service";
import { emitExitCompleted } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestAwaitingPaymentSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));
vi.mock("@/modules/printer/printer.service", () => ({
  printReceipt: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/websocket/socketServer", () => ({
  emitExitCompleted: vi.fn(),
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
  await db("tb_organizations").where({ id: orgId }).update({ printer_ip: "192.168.1.90" });
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

describe("GET /api/parking/sessions/awaiting-payment", () => {
  it("awaiting_payment sessiyalarni ro'yxatlaydi, is_overdue to'g'ri hisoblanadi", async () => {
    const freshId = await createTestAwaitingPaymentSession(orgId, "01E111AA", {
      exitedAt: new Date(),
    });
    const overdueId = await createTestAwaitingPaymentSession(orgId, "01E222AA", {
      exitedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await createTestActiveSession(orgId, "01E333AA");

    const res = await request(buildApp())
      .get("/api/parking/sessions/awaiting-payment")
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);

    const fresh = res.body.sessions.find((s: { id: number }) => s.id === freshId);
    const overdue = res.body.sessions.find((s: { id: number }) => s.id === overdueId);

    expect(fresh.is_overdue).toBe(false);
    expect(overdue.is_overdue).toBe(true);
  });

  it("boshqa org'ning awaiting_payment sessiyalarini qaytarmaydi", async () => {
    await createTestAwaitingPaymentSession(otherOrgId, "01E444AA");

    const res = await request(buildApp())
      .get("/api/parking/sessions/awaiting-payment")
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(0);
  });
});

describe("POST /api/parking/sessions/:id/confirm-cash-payment", () => {
  it("muvaffaqiyatli tasdiqlaydi — completed, rele/printer/websocket chaqiriladi", async () => {
    const sessionId = await createTestAwaitingPaymentSession(orgId, "01E555AA", { amount: 20000 });

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
    expect(res.body.session.payment_method).toBe("cash");
    expect(Number(res.body.payment.amount)).toBe(20000);

    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session.status).toBe("completed");
    expect(session.payment_method).toBe("cash");

    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(printReceipt).toHaveBeenCalledWith(
      "192.168.1.90",
      expect.objectContaining({ plateNumber: "01E555AA" })
    );
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01E555AA", amount: 20000 })
    );
  });

  it("printer xato bersa ham — jarayon muvaffaqiyatli yakunlanadi", async () => {
    vi.mocked(printReceipt).mockResolvedValueOnce(false);
    const sessionId = await createTestAwaitingPaymentSession(orgId, "01E666AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("completed");
  });

  it("sessiya awaiting_payment holatida bo'lmasa — 400 qaytaradi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01E777AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(400);
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("boshqa org'ga tegishli sessiya uchun 404 qaytaradi (scope tekshiruvi)", async () => {
    const foreignSessionId = await createTestAwaitingPaymentSession(otherOrgId, "01E888AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${foreignSessionId}/confirm-cash-payment`)
      .set("Authorization", authHeader(operator));

    expect(res.status).toBe(404);
    expect(openBarrier).not.toHaveBeenCalled();
  });
});
