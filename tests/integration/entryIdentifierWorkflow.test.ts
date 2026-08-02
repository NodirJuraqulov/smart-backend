import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import entryCandidatesRouter from "@/modules/entryCandidates/entryCandidates.routes";
import parkingSessionsEntryBarrierRouter from "@/modules/entryCandidates/parkingSessionsEntryBarrier.routes";
import { runEntryCandidatesExpiry } from "@/jobs/entryCandidatesExpiryJob";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import { openBarrier } from "@/modules/relay/relay.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
  createTestVipVehicle,
  setOrgCapacity,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true, detail: "opened" }),
}));

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitEntryBarrierFailed: vi.fn(),
  emitEntryCandidateCreated: vi.fn(),
  emitEntryCandidateResolved: vi.fn(),
  emitEntryCompleted: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/entry-candidates", entryCandidatesRouter);
app.use("/api/parking-sessions", parkingSessionsEntryBarrierRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let token: string;
let actor: AuthTokenPayload;
let authorization: string;
let imageBase64: string;

function dahuaPayload(plate: string | null, confidence = 95) {
  return {
    Picture: { NormalPic: { Content: imageBase64, PicName: "overview.jpg" } },
    Plate: { IsExist: plate !== null, PlateNumber: plate ?? "", Confidence: confidence },
    SnapInfo: {
      DeviceID: "entry-identifier-camera",
      SnapTime: DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss"),
    },
  };
}

async function postCamera(direction: "entry" | "exit", plate: string | null, confidence = 95) {
  return request(app)
    .post(`/api/webhook/camera/${token}/${direction}`)
    .set("Content-Type", "application/json")
    .send(dahuaPayload(plate, confidence));
}

async function entryCandidate() {
  return db("tb_entry_candidates").where({ org_id: orgId }).orderBy("id", "desc").first();
}

async function exitCandidate(plate: string | null) {
  await postCamera("exit", plate);
  return db("tb_exit_candidates").where({ org_id: orgId }).orderBy("id", "desc").first();
}

async function acceptCandidate(candidateId: number, plateNumber: string) {
  return request(app)
    .post(`/api/entry-candidates/${candidateId}/accept`)
    .set("Authorization", authorization)
    .send({ plate_number: plateNumber });
}

async function manualEntry(body: Record<string, unknown>) {
  return request(app)
    .post("/api/parking-sessions/manual-entry")
    .set("Authorization", authorization)
    .send(body);
}

async function searchExit(candidateId: number, plate?: string) {
  return request(app)
    .post(`/api/exit-candidates/${candidateId}/search`)
    .set("Authorization", authorization)
    .send(plate === undefined ? {} : { plate });
}

beforeAll(async () => {
  await assertTestDatabase();
  imageBase64 = (await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#444444" },
  }).jpeg().toBuffer()).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  token = `identifier-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: token,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestTariff(otherOrgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
  authorization = `Bearer ${signAccessToken(actor)}`;
  vi.mocked(openBarrier).mockReset().mockResolvedValue({ status: "opened", success: true, detail: "opened" });
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearWebhookDedupeCache();
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("entry identifier production workflow", () => {
  it("1. capacity bor, plate aniq va yaxshi confidence avtomatik sessiya yaratadi", async () => {
    await setOrgCapacity(orgId, 2);
    const response = await postCamera("entry", "01P100AA", 96);
    expect(response.status).toBe(200);
    expect(await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01P100AA" }).first()).toMatchObject({
      status: "active",
    });
    expect(await db("tb_entry_candidates").where({ org_id: orgId }).first()).toBeUndefined();
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
  });

  it("2. capacity bor va plate yo'q bo'lsa plate_not_detected candidate yaratadi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    expect(await entryCandidate()).toMatchObject({ detected_plate: null, reason: "plate_not_detected", status: "pending" });
  });

  it("3. capacity to'la va plate bor bo'lsa capacity_full candidate yaratadi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", "01P103AA");
    expect(await entryCandidate()).toMatchObject({ detected_plate: "01P103AA", reason: "capacity_full" });
  });

  it("4. capacity to'la va plate yo'q bo'lsa qo'shma sabab saqlanadi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", null);
    expect(await entryCandidate()).toMatchObject({
      detected_plate: null,
      reason: "capacity_full_and_plate_not_detected",
    });
  });

  it("5. bir xil plate uchun ikkinchi webhook yangi candidate yaratmaydi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", "01P105AA", 70);
    const first = await entryCandidate();
    await db("tb_webhook_events").where({ id: first.webhook_event_id }).update({
      created_at: db.raw("DATE_SUB(NOW(), INTERVAL 20 SECOND)"),
    });
    await postCamera("entry", "01P105AA", 88);
    const rows = await db("tb_entry_candidates").where({ org_id: orgId, detected_plate: "01P105AA" });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].confidence)).toBe(88);
  });

  it("6. plate null webhooklar 60 soniyada bitta candidate'da coalesce bo'ladi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null, 41);
    await postCamera("entry", null, 52);
    const rows = await db("tb_entry_candidates").where({ org_id: orgId }).whereNull("detected_plate");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].confidence)).toBe(52);
  });

  it("7. acceptda operator kiritgan haqiqiy plate sessiyaga yoziladi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    const pending = await entryCandidate();
    const response = await acceptCandidate(pending.id, "01 p 107 aa");
    expect(response.status).toBe(200);
    expect(await db("tb_parking_sessions").where({ id: response.body.session_id }).first()).toMatchObject({
      plate_number: "01P107AA",
    });
  });

  it("8. operator belgilagan AUTO001 identifier sessiya va fuzzy searchda ishlaydi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    const accepted = await acceptCandidate((await entryCandidate()).id, "AUTO001");
    const pendingExit = await exitCandidate(null);
    const response = await searchExit(pendingExit.id, "AUTO001");
    expect(accepted.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      session_id: String(accepted.body.session_id),
      plate_number: "AUTO001",
    });
  });

  it("9. accept plate bo'sh bo'lsa 400 qaytaradi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    const response = await acceptCandidate((await entryCandidate()).id, "   ");
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Davlat raqami kiritilishi kerak");
  });

  it("10. acceptdagi plate allaqachon active bo'lsa 409 qaytaradi", async () => {
    await setOrgCapacity(orgId, 2);
    await createTestActiveSession(orgId, "01P110AA");
    await postCamera("entry", null);
    expect((await acceptCandidate((await entryCandidate()).id, "01P110AA")).status).toBe(409);
  });

  it("11. decline sessiya va relay yaratmaydi, audit yozadi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", "01P111AA");
    const pending = await entryCandidate();
    vi.clearAllMocks();
    const response = await request(app)
      .post(`/api/entry-candidates/${pending.id}/decline`)
      .set("Authorization", authorization)
      .send({ note: "Rad etildi" });
    expect(response.status).toBe(200);
    expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeUndefined();
    expect(openBarrier).not.toHaveBeenCalled();
    expect(await db("tb_activity_logs").where({ action: "parking.entry_candidate_declined", target_id: pending.id }).first()).toBeTruthy();
  });

  it("12. manual entry plate bilan sessiya, relay va audit yaratadi", async () => {
    const response = await manualEntry({ plate_number: "01P112AA", reason: "Kamera ishlamadi", note: "Qo'lda" });
    expect(response.status).toBe(200);
    expect(await db("tb_parking_sessions").where({ id: response.body.session_id }).first()).toMatchObject({
      plate_number: "01P112AA",
      entry_method: "manual",
    });
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
    expect(await db("tb_activity_logs").where({ action: "parking.manual_entry", target_id: response.body.session_id }).first()).toBeTruthy();
  });

  it("13. manual entry active plate uchun 409 qaytaradi", async () => {
    await createTestActiveSession(orgId, "01P113AA");
    expect((await manualEntry({ plate_number: "01P113AA", reason: "Takror" })).status).toBe(409);
  });

  it("14. manual entry plate bo'sh bo'lsa 400 qaytaradi", async () => {
    const response = await manualEntry({ plate_number: " ", reason: "Kamera ishlamadi" });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Davlat raqami kiritilishi kerak");
  });

  it("15. 10 daqiqadan eski pending candidate expired bo'ladi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", "01P115AA");
    const pending = await entryCandidate();
    await db("tb_entry_candidates").where({ id: pending.id }).update({
      created_at: new Date(Date.now() - 11 * 60_000),
    });
    expect(await runEntryCandidatesExpiry()).toBe(1);
    expect(await db("tb_entry_candidates").where({ id: pending.id }).first()).toMatchObject({ status: "expired" });
  });

  it("16. expired candidate next orqali qaytmaydi", async () => {
    await setOrgCapacity(orgId, 0);
    await postCamera("entry", "01P116AA");
    const pending = await entryCandidate();
    await db("tb_entry_candidates").where({ id: pending.id }).update({
      created_at: new Date(Date.now() - 11 * 60_000),
    });
    await runEntryCandidatesExpiry();
    expect((await request(app).get("/api/entry-candidates/next").set("Authorization", authorization)).status).toBe(204);
  });

  it("17. exit search barcha active identifierlarni fuzzy natijaga qo'shadi", async () => {
    const custom = await manualEntry({ plate_number: "AUTO017", reason: "Maxsus identifier" });
    await createTestActiveSession(orgId, "01P117AA");
    const response = await searchExit((await exitCandidate(null)).id, "AUTO017");
    expect(response.body.results[0]).toMatchObject({
      session_id: String(custom.body.session_id),
      plate_number: "AUTO017",
    });
    expect(response.body.active_sessions).toHaveLength(2);
    expect(response.body.active_sessions[0]).not.toHaveProperty("is_plateless");
  });

  it("18. exit search platesiz faqat active_sessions qaytaradi", async () => {
    await createTestActiveSession(orgId, "01P118AA");
    const response = await searchExit((await exitCandidate(null)).id);
    expect(response.body.results).toEqual([]);
    expect(response.body.active_sessions).toHaveLength(1);
  });

  it("19. operator qo'lda VIP plate kiritsa session_source vip bo'ladi", async () => {
    await createTestVipVehicle(orgId, "01P119AA");
    const response = await manualEntry({ plate_number: "01P119AA", reason: "Kamera ishlamadi" });
    expect(await db("tb_parking_sessions").where({ id: response.body.session_id }).first()).toMatchObject({
      session_source: "vip",
    });
  });

  it("20. kirishda tanilgan, chiqishda tanilmagan plate fuzzy searchda topiladi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", "01P120AA");
    const response = await searchExit((await exitCandidate(null)).id, "01P120AA");
    expect(response.body.results[0]).toMatchObject({ plate_number: "01P120AA" });
  });

  it("21. kirishda operator kiritgan haqiqiy plate chiqishda exact match bo'ladi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    const accepted = await acceptCandidate((await entryCandidate()).id, "01P121AA");
    const pendingExit = await exitCandidate("01P121AA");
    expect(pendingExit.matched_session_id).toBe(accepted.body.session_id);
  });

  it("22. operator belgilagan identifier chiqish qidiruvida aynan topiladi", async () => {
    await setOrgCapacity(orgId, 2);
    await postCamera("entry", null);
    const accepted = await acceptCandidate((await entryCandidate()).id, "YANGI022");
    const response = await searchExit((await exitCandidate(null)).id, "YANGI022");
    expect(response.body.results[0]).toMatchObject({
      session_id: String(accepted.body.session_id),
      plate_number: "YANGI022",
    });
  });
});
