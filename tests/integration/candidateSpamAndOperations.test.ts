import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import parkingSessionsRouter from "@/modules/entryCandidates/parkingSessionsEntryBarrier.routes";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import organizationsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { encryptSecret } from "@/utils/encryption";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

let orgId: number;
let webhookToken: string;
let actor: AuthTokenPayload;
let authorization: string;
let jpegBase64: string;

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/parking-sessions", parkingSessionsRouter);
app.use("/api/organizations", organizationsRouter);
app.use(errorHandler);

function dahuaPayload(plate: string | null, vehicleDetected = true) {
  return {
    Picture: {
      NormalPic: {
        Content: jpegBase64,
        PicName: `${plate ?? "unknown"}-${Date.now()}.jpg`,
      },
    },
    Plate: {
      IsExist: plate !== null,
      PlateNumber: plate ?? "",
      Confidence: 90,
    },
    ...(vehicleDetected
      ? { Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } } }
      : {}),
    SnapInfo: {
      DeviceID: "spam-guard-camera",
      SnapTime: new Date().toISOString(),
    },
  };
}

function postWebhook(direction: "entry" | "exit", plate: string | null, vehicleDetected = true) {
  return request(app)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plate, vehicleDetected));
}

function rpcResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulRelayResponses() {
  return [
    rpcResponse({
      result: false,
      params: { random: "ABC123", realm: "Dahua" },
      session: "temporary-entry",
    }),
    rpcResponse({ result: true, session: "authenticated-entry" }),
    rpcResponse({ result: true }),
    rpcResponse({
      result: false,
      params: { random: "XYZ789", realm: "Dahua" },
      session: "temporary-exit",
    }),
    rpcResponse({ result: true, session: "authenticated-exit" }),
    rpcResponse({ result: true }),
  ];
}

async function createWebhookEvent(direction: "entry" | "exit", plate: string | null) {
  const [id] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plate,
    direction,
    camera_event_at: new Date(),
  });
  return id;
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `spam-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId);
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
  authorization = `Bearer ${signAccessToken(actor)}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("candidate spam himoyasi", () => {
  it("exit resolved candidate cooldown yangi candidate yaratmaydi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01A100AA");
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      exited_at: new Date(),
      amount: 0,
      active_plate_key: null,
    });
    const previousEventId = await createWebhookEvent("exit", "01A100AA");
    await db("tb_webhook_events").where({ id: previousEventId }).update({
      created_at: new Date(Date.now() - 60_000),
      processing_result: "exit_completed",
    });
    await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: previousEventId,
      detected_plate: "01A100AA",
      matched_session_id: sessionId,
      resolved_session_id: sessionId,
      confidence: 90,
      camera_event_at: new Date(Date.now() - 60_000),
      status: "accepted",
      resolution_type: "exact",
      resolved_by: actor.id,
      resolved_at: new Date(),
    });

    const response = await postWebhook("exit", "01A100AA");
    const candidates = await db("tb_exit_candidates").where({ org_id: orgId });
    const audit = await db("tb_webhook_events").where({ org_id: orgId }).orderBy("id", "desc").first();

    expect(response.body).toMatchObject({ ignored: true, reason: "resolved_recently_ignored" });
    expect(candidates).toHaveLength(1);
    expect(audit.processing_result).toBe("resolved_recently_ignored");
  });

  it("entry active session mavjud bo'lsa eskisini yopib yangi sessiya ochadi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01A200AA");

    const response = await postWebhook("entry", "01A200AA");
    const sessions = await db("tb_parking_sessions").where({ org_id: orgId }).orderBy("id", "asc");
    const candidates = await db("tb_entry_candidates").where({ org_id: orgId });
    const audit = await db("tb_webhook_events").where({ org_id: orgId }).first();

    expect(response.body.reason).toBeUndefined();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      status: "completed",
      exit_method: "auto_closed_on_reentry",
    });
    expect(sessions[1].status).toBe("active");
    expect(candidates).toHaveLength(0);
    expect(audit).toMatchObject({
      processing_result: "entry_created",
      session_id: sessions[1].id,
    });
  });

  it("vehicle region yo'q entry va exit webhooklar faqat audit qilinadi", async () => {
    const entry = await postWebhook("entry", "01A300AA", false);
    const exit = await postWebhook("exit", "01A301AA", false);
    const events = await db("tb_webhook_events").where({ org_id: orgId }).orderBy("id");

    expect(entry.body.reason).toBe("no_vehicle_detected_ignored");
    expect(exit.body.reason).toBe("no_vehicle_detected_ignored");
    expect(events.map((event) => event.processing_result)).toEqual([
      "no_vehicle_detected_ignored",
      "no_vehicle_detected_ignored",
    ]);
    expect(await db("tb_entry_candidates").where({ org_id: orgId })).toHaveLength(0);
    expect(await db("tb_exit_candidates").where({ org_id: orgId })).toHaveLength(0);
    expect(await db("tb_parking_sessions").where({ org_id: orgId })).toHaveLength(0);
  });

  it("vehicle region mavjud plate null event plate_not_detected candidate yaratadi", async () => {
    const response = await postWebhook("entry", null);
    const candidate = await db("tb_entry_candidates").where({ org_id: orgId }).first();

    expect(response.body.candidate_created).toBe(true);
    expect(candidate).toMatchObject({ detected_plate: null, reason: "plate_not_detected", status: "pending" });
  });

  it("uch belgidan qisqa plate null sifatida ishlanadi", async () => {
    await postWebhook("entry", "4X");
    const event = await db("tb_webhook_events").where({ org_id: orgId }).first();
    const candidate = await db("tb_entry_candidates").where({ org_id: orgId }).first();

    expect(event.plate_number).toBeNull();
    expect(candidate).toMatchObject({ detected_plate: null, reason: "plate_not_detected" });
  });

  it("null plate eventlar ikki daqiqa farq bilan bitta candidatega coalesce qilinadi", async () => {
    await postWebhook("exit", null);
    const firstCandidate = await db("tb_exit_candidates").where({ org_id: orgId }).first();
    await db("tb_exit_candidates").where({ id: firstCandidate.id }).update({
      camera_event_at: new Date(Date.now() - 2 * 60_000),
    });

    const response = await postWebhook("exit", null);
    const candidates = await db("tb_exit_candidates").where({ org_id: orgId });

    expect(response.body).toMatchObject({ candidate_created: false, candidate_coalesced: true });
    expect(candidates).toHaveLength(1);
  });
});

describe("operatsion tiklash endpointlari", () => {
  it("completed sessiya sabab exit confirm aniq 409 xabar qaytaradi", async () => {
    const sessionId = await createTestActiveSession(orgId, "01B100AA");
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      exited_at: new Date(),
      active_plate_key: null,
    });
    const eventId = await createWebhookEvent("exit", "01B100AA");
    const [candidateId] = await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: eventId,
      detected_plate: "01B100AA",
      matched_session_id: sessionId,
      confidence: 90,
      camera_event_at: new Date(),
    });

    const response = await request(app)
      .post(`/api/exit-candidates/${candidateId}/confirm`)
      .set("Authorization", authorization)
      .send({ payment_method: "cash" });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe("Bu mashina allaqachon chiqib ketgan");
  });

  it("emergency barrier entry va exit relaylarini side-effectsiz chaqiradi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({
      entry_camera_relay_host: "10.0.0.1",
      entry_camera_relay_port: 80,
      entry_camera_relay_username: "admin",
      entry_camera_relay_password_encrypted: encryptSecret("secret"),
      entry_camera_relay_channel: 1,
      exit_camera_relay_host: "10.0.0.2",
      exit_camera_relay_port: 80,
      exit_camera_relay_username: "admin",
      exit_camera_relay_password_encrypted: encryptSecret("secret"),
      exit_camera_relay_channel: 1,
    });
    await createTestActiveSession(orgId, "01B300AA");
    const eventId = await createWebhookEvent("exit", "01B301AA");
    await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: eventId,
      detected_plate: "01B301AA",
      confidence: 80,
      camera_event_at: new Date(),
    });
    const sessionCountBefore = Number(
      (await db("tb_parking_sessions").where({ org_id: orgId }).count<{ count: string }[]>("id as count"))[0].count
    );
    const candidateCountBefore = Number(
      (await db("tb_exit_candidates").where({ org_id: orgId }).count<{ count: string }[]>("id as count"))[0].count
    );
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of successfulRelayResponses()) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    const entry = await request(app)
      .post(`/api/organizations/${orgId}/emergency-barrier-open`)
      .set("Authorization", authorization)
      .send({ direction: "entry", reason: "Favqulodda kirish" });
    const exit = await request(app)
      .post(`/api/organizations/${orgId}/emergency-barrier-open`)
      .set("Authorization", authorization)
      .send({ direction: "exit", reason: "Favqulodda chiqish" });
    const sessionCountAfter = Number(
      (await db("tb_parking_sessions").where({ org_id: orgId }).count<{ count: string }[]>("id as count"))[0].count
    );
    const candidateCountAfter = Number(
      (await db("tb_exit_candidates").where({ org_id: orgId }).count<{ count: string }[]>("id as count"))[0].count
    );
    const audits = await db("tb_activity_logs").where({ action: "emergency_open", target_id: orgId });

    expect(entry.body).toEqual({ barrier_status: "opened" });
    expect(exit.body).toEqual({ barrier_status: "opened" });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://10.0.0.1/RPC2_Login",
      "http://10.0.0.1/RPC2_Login",
      "http://10.0.0.1/RPC2",
      "http://10.0.0.2/RPC2_Login",
      "http://10.0.0.2/RPC2_Login",
      "http://10.0.0.2/RPC2",
    ]);
    expect(sessionCountAfter).toBe(sessionCountBefore);
    expect(candidateCountAfter).toBe(candidateCountBefore);
    expect(audits).toHaveLength(2);
  });

  it("stale-sessions faqat 24 soatdan eski active sessiyalarni qaytaradi", async () => {
    const staleId = await createTestActiveSession(orgId, "01B400AA", new Date(Date.now() - 25 * 60 * 60_000));
    await createTestActiveSession(orgId, "01B401AA", new Date(Date.now() - 23 * 60 * 60_000));
    const completedId = await createTestActiveSession(orgId, "01B402AA", new Date(Date.now() - 30 * 60 * 60_000));
    await db("tb_parking_sessions").where({ id: completedId }).update({
      status: "completed",
      exited_at: new Date(),
      active_plate_key: null,
    });

    const response = await request(app)
      .get(`/api/organizations/${orgId}/stale-sessions`)
      .set("Authorization", authorization);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      session_id: staleId,
      plate_number: "01B400AA",
    });
    expect(response.body[0].duration_minutes).toBeGreaterThanOrEqual(1500);
  });
});
