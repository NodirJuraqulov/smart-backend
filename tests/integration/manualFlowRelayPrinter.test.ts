import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingRouter from "@/modules/parking/parking.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import { printReceipt } from "@/modules/printer/printer.service";
import { emitEntryDetected, emitExitCompleted, emitRelayFailed } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));
vi.mock("@/modules/printer/printer.service", () => ({
  printReceipt: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));
vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitRelayFailed: vi.fn(),
}));

let orgId: number;
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
  await db("tb_organizations").where({ id: orgId }).update({ printer_ip: "192.168.1.95" });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestSettings(orgId, { work_hours_enabled: false });
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

describe("POST /api/parking/entry/manual", () => {
  it("sessiya yaratilgandan keyin rele va entry_detected eventi chaqiriladi", async () => {
    const res = await request(buildApp())
      .post("/api/parking/entry/manual")
      .set("Authorization", authHeader(operator))
      .send({ plate_number: "01H111AA" });

    expect(res.status).toBe(201);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
    expect(emitEntryDetected).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01H111AA" })
    );
  });

  it("rele xato bersa ham — sessiya baribir yaratiladi, relay_failed eventi yuboriladi", async () => {
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false });

    const res = await request(buildApp())
      .post("/api/parking/entry/manual")
      .set("Authorization", authHeader(operator))
      .send({ plate_number: "01H222AA" });

    expect(res.status).toBe(201);
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01H222AA" }).first();
    expect(session.status).toBe("active");
    expect(emitRelayFailed).toHaveBeenCalledWith(orgId, expect.objectContaining({ direction: "entry" }));
  });
});

describe("POST /api/parking/exit/manual", () => {
  it("sessiya yopilgandan keyin rele, printer va exit_completed eventi chaqiriladi", async () => {
    await createTestActiveSession(orgId, "01H333AA");

    const res = await request(buildApp())
      .post("/api/parking/exit/manual")
      .set("Authorization", authHeader(operator))
      .send({ plate_number: "01H333AA" });

    expect(res.status).toBe(200);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(printReceipt).toHaveBeenCalledWith(
      "192.168.1.95",
      expect.objectContaining({ plateNumber: "01H333AA" })
    );
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01H333AA" })
    );
  });

  it("rele va printer xato bersa ham — sessiya baribir yopiladi", async () => {
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false });
    vi.mocked(printReceipt).mockResolvedValueOnce({ status: "failed", success: false });
    await createTestActiveSession(orgId, "01H444AA");

    const res = await request(buildApp())
      .post("/api/parking/exit/manual")
      .set("Authorization", authHeader(operator))
      .send({ plate_number: "01H444AA" });

    expect(res.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01H444AA" }).first();
    expect(session.status).toBe("completed");
  });
});

describe("POST /api/parking/sessions/:id/force-close", () => {
  it("sessiya majburiy yopilgandan keyin rele, printer va exit_completed eventi chaqiriladi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01H555AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/force-close`)
      .set("Authorization", authHeader(operator))
      .send({});

    expect(res.status).toBe(200);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(printReceipt).toHaveBeenCalledWith(
      "192.168.1.95",
      expect.objectContaining({ plateNumber: "01H555AA" })
    );
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01H555AA" })
    );
  });

  it("rele va printer xato bersa ham — sessiya baribir yopiladi", async () => {
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false });
    vi.mocked(printReceipt).mockResolvedValueOnce({ status: "failed", success: false });
    const sessionId = await createTestActiveSession(orgId, "01H666AA");

    const res = await request(buildApp())
      .post(`/api/parking/sessions/${sessionId}/force-close`)
      .set("Authorization", authHeader(operator))
      .send({});

    expect(res.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(session.status).toBe("completed");
    expect(emitRelayFailed).toHaveBeenCalledWith(orgId, expect.objectContaining({ direction: "exit" }));
  });
});
