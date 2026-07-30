import http from "http";
import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { getWebhookEventDiagnostics } from "@/modules/webhook/webhookDiagnostics.service";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
} from "./helpers";

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "disabled", success: true }),
}));

let orgId: number;
let otherOrgId: number;
let webhookToken: string;
let server: http.Server;
let NORMAL_JPEG_BASE64: string;

function dahuaPayload(plateNumber: string, confidence?: number | string) {
  return {
    Picture: {
      NormalPic: {
        Content: `data:image/jpeg;base64,${NORMAL_JPEG_BASE64}`,
        PicName: `${plateNumber}-20260730120000.jpg`,
      },
    },
    Plate: {
      IsExist: true,
      PlateNumber: plateNumber,
      ...(confidence === undefined ? {} : { Confidence: confidence }),
    },
    SnapInfo: {
      DeviceID: "dahua-audit-camera",
      SnapTime: "2026-07-30 12:00:00",
    },
  };
}

function postDahua(direction: "entry" | "exit", plateNumber: string, confidence?: number | string) {
  return request(server)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plateNumber, confidence));
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  server = http.createServer(app);
  const overview = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#444" } })
    .jpeg()
    .toBuffer();
  NORMAL_JPEG_BASE64 = overview.toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  webhookToken = `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId, { price_per_hour: 5000 });
});

afterEach(async () => {
  await clearWebhookDedupeCache();
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("tb_webhook_events camera audit", () => {
  it("entry va exit muvaffaqiyatida confidence, metadata va session ID saqlaydi", async () => {
    expect((await postDahua("entry", "01A123BC", "4.5")).status).toBe(200);
    expect((await postDahua("exit", "01A123BC", 96)).status).toBe(200);

    const session = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A123BC" })
      .first();
    const events = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "01A123BC" })
      .orderBy("id");

    expect(session.status).toBe("awaiting_payment");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      direction: "entry",
      processing_result: "entry_created",
      device_id: "dahua-audit-camera",
      session_id: session.id,
    });
    expect(Number(events[0].confidence)).toBe(4.5);
    expect(events[0].camera_event_at).toBeTruthy();
    expect(events[1]).toMatchObject({
      direction: "exit",
      processing_result: "exit_awaiting_payment",
      session_id: session.id,
    });
    expect(Number(events[1].confidence)).toBe(96);
    expect(events[0]).not.toHaveProperty("raw_payload");
    expect(events[0]).not.toHaveProperty("image_base64");
  });

  it("unmatched exit uchun aniq result va reason yozadi", async () => {
    await postDahua("exit", "01A555BC", 42);

    const event = await db("tb_webhook_events").where({ org_id: orgId }).first();
    expect(event).toMatchObject({
      plate_number: "01A555BC",
      processing_result: "unmatched_exit",
      processing_reason: "active_session_not_found",
      session_id: null,
    });
    expect(Number(event.confidence)).toBe(42);
  });

  it("same-direction duplicate audit qilinadi va sessiya takrorlanmaydi", async () => {
    await postDahua("entry", "01A666BC", 90);
    const duplicate = await postDahua("entry", "01A666BC", 91);

    expect(duplicate.body).toMatchObject({ parsed: true, duplicate: true });
    const events = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "01A666BC" })
      .orderBy("id");
    expect(events.map((event) => event.processing_result)).toEqual([
      "entry_created",
      "duplicate_same_direction",
    ]);
    const [{ count }] = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A666BC" })
      .count<{ count: string }[]>("id as count");
    expect(Number(count)).toBe(1);
  });

  it("opposite-camera echo audit qilinadi, lekin entry sessiyasi yopilmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ gate_layout: "shared" });
    await postDahua("entry", "01A777BC", 93);
    const echo = await postDahua("exit", "01A777BC", 88);

    expect(echo.body).toMatchObject({ ignored: true, reason: "opposite_camera_echo" });
    const echoEvent = await db("tb_webhook_events")
      .where({ org_id: orgId, direction: "exit" })
      .first();
    expect(echoEvent).toMatchObject({
      processing_result: "opposite_camera_echo",
      processing_reason: "cross_camera_guard",
    });
    const session = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A777BC" })
      .first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
  });

  it("production-style missing prefix shared_lane_conflict bo'ladi va hech qanday side-effect qilmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ gate_layout: "shared" });
    await postDahua("entry", "01C914AD", 91);
    const sessionBefore = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01C914AD" })
      .first();
    vi.clearAllMocks();

    const conflict = await postDahua("exit", "C914AD", 50);

    expect(conflict.body).toMatchObject({
      ok: true,
      parsed: true,
      ignored: true,
      reason: "shared_lane_conflict",
    });
    const sessionAfter = await db("tb_parking_sessions").where({ id: sessionBefore.id }).first();
    expect(sessionAfter.status).toBe("active");
    expect(sessionAfter.exited_at).toBeNull();
    expect(sessionAfter.amount).toBeNull();
    expect(openBarrier).not.toHaveBeenCalled();
    const [{ paymentCount }] = await db("tb_payments")
      .where({ org_id: orgId })
      .count<{ paymentCount: string }[]>("id as paymentCount");
    expect(Number(paymentCount)).toBe(0);
    const audit = await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "C914AD" })
      .first();
    expect(audit).toMatchObject({
      processing_result: "shared_lane_conflict",
      processing_reason: "near_plate_cross_camera_guard",
      session_id: null,
      processed_at: null,
    });
    expect(audit.vehicle_image_path).toContain(`/${audit.id}/vehicle.jpg`);
  });

  it("null confidence qabul qilinadi va boshqa tashkilot auditiga aralashmaydi", async () => {
    await postDahua("entry", "01A888BC");

    const ownEvents = await db("tb_webhook_events").where({ org_id: orgId });
    const otherEvents = await db("tb_webhook_events").where({ org_id: otherOrgId });
    expect(ownEvents).toHaveLength(1);
    expect(ownEvents[0].confidence).toBeNull();
    expect(otherEvents).toHaveLength(0);
  });

  it("diagnostic aggregation organization-scoped va zero-safe ishlaydi", async () => {
    await postDahua("exit", "01A999BC", 42);
    await db("tb_webhook_events").insert({
      org_id: otherOrgId,
      plate_number: "X",
      direction: "exit",
      confidence: 99,
      processing_result: "unmatched_exit",
    });

    const diagnostics = await getWebhookEventDiagnostics(orgId, {
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });

    expect(diagnostics.unmatched_exit_count).toBe(1);
    expect(diagnostics.successful_exit_count).toBe(0);
    expect(diagnostics.null_confidence_count).toBe(0);
    expect(diagnostics.malformed_plate_count).toBe(0);
    expect(diagnostics.confidence_by_direction).toHaveLength(1);
    expect(Number(diagnostics.confidence_by_direction[0].average_confidence)).toBe(42);
    expect(diagnostics.grouped_by_hour).toHaveLength(1);
    expect(diagnostics.grouped_by_day).toHaveLength(1);
  });
});
