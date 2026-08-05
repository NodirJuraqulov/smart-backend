import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import medplusWebhookRouter from "@/modules/medplus/medplusWebhook.routes";
import medplusAdminRouter from "@/modules/medplus/medplusAdmin.routes";
import { runClinicDiscountsExpiry } from "@/modules/medplus/clinicDiscountsExpiry.service";
import { runInpatientVehiclesExpiry } from "@/modules/medplus/inpatientVehiclesExpiry.service";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => {
  const createMock = vi.fn as unknown as () => ReturnType<typeof vi.fn>;
  return { openBarrier: createMock() };
});

vi.mock("@/websocket/socketServer", () => {
  const createMock = vi.fn as unknown as () => ReturnType<typeof vi.fn>;
  return {
    emitEntryDetected: createMock(),
    emitEntryBarrierFailed: createMock(),
    emitEntryCandidateCreated: createMock(),
    emitEntryCandidateResolved: createMock(),
    emitEntryCompleted: createMock(),
    emitParkingFull: createMock(),
    emitExitAwaitingPayment: createMock(),
    emitExitCompleted: createMock(),
    emitExitCandidateCreated: createMock(),
    emitExitCandidateResolved: createMock(),
    emitPlateNotRecognizedForExit: createMock(),
    emitPublicEntryStatusChanged: createMock(),
    emitPublicExitStatusChanged: createMock(),
    emitRelayFailed: createMock(),
    emitWebhookParseFailed: createMock(),
  };
});

const app = express();
app.use(express.json());
app.use("/api/medplus/webhook", medplusWebhookRouter);
app.use("/api/organizations", medplusAdminRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let discountToken: string;
let inpatientToken: string;
let owner: AuthTokenPayload;
let otherOwner: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createSession(
  plate: string,
  pricePerHour = 5000,
  enteredMinutesAgo = 61
): Promise<number> {
  const id = await createTestActiveSession(orgId, plate, new Date(Date.now() - enteredMinutesAgo * 60_000));
  await db("tb_parking_sessions").where({ id }).update({
    session_source: "regular",
    tariff_price_per_hour: pricePerHour,
    tariff_grace_period_minutes: 0,
    tariff_intervals_snapshot: null,
  });
  return id;
}

async function createPendingExitCandidate(plate: string, matchedSessionId: number | null): Promise<number> {
  const now = new Date();
  const [webhookEventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plate,
    direction: "exit",
    camera_event_at: now,
    processing_result: "exit_candidate_pending",
    created_at: now,
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: plate,
    matched_session_id: matchedSessionId,
    confidence: 90,
    camera_event_at: now,
    status: "pending",
    created_at: now,
    updated_at: now,
  });
  return candidateId;
}

async function confirmCandidate(candidateId: number, paymentMethod = "cash"): Promise<request.Response> {
  return request(app)
    .post(`/api/exit-candidates/${candidateId}/confirm`)
    .set("Authorization", authorization(owner))
    .send({ payment_method: paymentMethod });
}

interface ActivityLogRow {
  action: string;
  details: Record<string, unknown> | null;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  discountToken = `discount-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  inpatientToken = `inpatient-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    medplus_discount_webhook_token: discountToken,
    medplus_inpatient_webhook_token: inpatientToken,
    clinic_discount_percent: 20,
  });
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  const otherOwnerUser = await createTestUser(otherOrgId, { role: "owner" });
  otherOwner = { id: otherOwnerUser.id, org_id: otherOrgId, role: "owner" };
  (openBarrier as unknown as ReturnType<typeof vi.fn>).mockReset();
  (openBarrier as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "opened", success: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("MedPlus integration", () => {
  it("1. discount webhook to'g'ri token bilan yangi pending yozuv yaratadi", async () => {
    const response = await request(app)
      .post(`/api/medplus/webhook/${discountToken}/discount`)
      .send({ plate_number: "01a777aa", source_reference: "patient-1" });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(typeof response.body.discount_id).toBe("number");
    const row = await db("tb_clinic_discounts").where({ id: response.body.discount_id }).first();
    expect(row).toMatchObject({
      org_id: orgId,
      plate_number: "01A777AA",
      discount_percent: 20,
      status: "pending",
      source_reference: "patient-1",
    });
  });

  it("2. discount webhook noto'g'ri token bilan 404 qaytaradi", async () => {
    const response = await request(app)
      .post(`/api/medplus/webhook/wrong-token/discount`)
      .send({ plate_number: "01A777AA" });
    expect(response.status).toBe(404);
  });

  it("3. discount webhook bir xil plate+kun uchun ikkinchi marta chaqirilsa dublikat yaratmaydi", async () => {
    const first = await request(app)
      .post(`/api/medplus/webhook/${discountToken}/discount`)
      .send({ plate_number: "01B888BB" });
    const second = await request(app)
      .post(`/api/medplus/webhook/${discountToken}/discount`)
      .send({ plate_number: "01b888bb" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.discount_id).toBe(first.body.discount_id);
    const count = await db("tb_clinic_discounts").where({ org_id: orgId, plate_number: "01B888BB" });
    expect(count).toHaveLength(1);
  });

  it("4. inpatient webhook yangi active yozuv yaratadi, valid_until to'g'ri hisoblanadi", async () => {
    const response = await request(app)
      .post(`/api/medplus/webhook/${inpatientToken}/inpatient`)
      .send({ plate_number: "01C999CC", duration_days: 5, patient_reference: "p-1", patient_name: "Ali" });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const expectedValidUntil = DateTime.now().setZone("Asia/Tashkent").plus({ days: 5 }).toFormat("yyyy-MM-dd");
    expect(response.body.valid_until).toBe(expectedValidUntil);
    const row = await db("tb_inpatient_vehicles").where({ id: response.body.inpatient_id }).first();
    expect(row).toMatchObject({
      org_id: orgId,
      plate_number: "01C999CC",
      status: "active",
      patient_reference: "p-1",
      patient_name: "Ali",
    });
  });

  it("5. inpatient webhook mavjud active yozuv uchun qayta chaqirilsa muddat yangilanadi", async () => {
    const first = await request(app)
      .post(`/api/medplus/webhook/${inpatientToken}/inpatient`)
      .send({ plate_number: "01D111DD", duration_days: 3 });
    const second = await request(app)
      .post(`/api/medplus/webhook/${inpatientToken}/inpatient`)
      .send({ plate_number: "01D111DD", duration_days: 10 });
    expect(second.body.inpatient_id).toBe(first.body.inpatient_id);
    const rows = await db("tb_inpatient_vehicles").where({ org_id: orgId, plate_number: "01D111DD" });
    expect(rows).toHaveLength(1);
    const expectedValidUntil = DateTime.now().setZone("Asia/Tashkent").plus({ days: 10 }).toFormat("yyyy-MM-dd");
    expect(String(rows[0].valid_until).slice(0, 10)).toBe(expectedValidUntil);
  });

  it("6. exit confirm: statsionar mashina uchun amount=0, payment yaratilmaydi", async () => {
    const sessionId = await createSession("01E222EE");
    await db("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: "01E222EE",
      valid_from: DateTime.now().toFormat("yyyy-MM-dd"),
      valid_until: DateTime.now().plus({ days: 2 }).toFormat("yyyy-MM-dd"),
      status: "active",
    });
    const candidateId = await createPendingExitCandidate("01E222EE", sessionId);
    const response = await confirmCandidate(candidateId);
    expect(response.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(Number(session.amount)).toBe(0);
    const payments = await db("tb_payments").where({ session_id: sessionId });
    expect(payments).toHaveLength(0);
    const logs = await db<ActivityLogRow>("tb_activity_logs").where({
      action: "inpatient_free_exit",
      target_id: candidateId,
    });
    expect(logs).toHaveLength(1);
  });

  it("7. exit confirm: pending discount mavjud plate uchun to'g'ri foizda amount kamayadi", async () => {
    const sessionId = await createSession("01F333FF", 5000, 61);
    const [discountId] = await db("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: "01F333FF",
      discount_percent: 20,
      status: "pending",
    });
    const candidateId = await createPendingExitCandidate("01F333FF", sessionId);
    const response = await confirmCandidate(candidateId);
    expect(response.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(Number(session.amount)).toBe(8000);
    const payment = await db("tb_payments").where({ session_id: sessionId }).first();
    expect(Number(payment.amount)).toBe(8000);
    const discount = await db("tb_clinic_discounts").where({ id: discountId }).first();
    expect(discount.status).toBe("used");
    expect(discount.used_session_id).toBe(sessionId);
    expect(discount.used_at).not.toBeNull();
    const logs = await db<ActivityLogRow>("tb_activity_logs").where({
      action: "clinic_discount_applied",
      target_id: candidateId,
    });
    expect(logs).toHaveLength(1);
  });

  it("8. exit confirm: statsionar va discount ikkalasi mavjud bo'lsa statsionar ustuvor", async () => {
    const sessionId = await createSession("01G444GG");
    await db("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: "01G444GG",
      valid_from: DateTime.now().toFormat("yyyy-MM-dd"),
      valid_until: DateTime.now().plus({ days: 2 }).toFormat("yyyy-MM-dd"),
      status: "active",
    });
    const [discountId] = await db("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: "01G444GG",
      discount_percent: 20,
      status: "pending",
    });
    const candidateId = await createPendingExitCandidate("01G444GG", sessionId);
    const response = await confirmCandidate(candidateId);
    expect(response.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(Number(session.amount)).toBe(0);
    const discount = await db("tb_clinic_discounts").where({ id: discountId }).first();
    expect(discount.status).toBe("pending");
  });

  it("9. exit confirm: discount/statsionar yo'q holatda oddiy hisoblash o'zgarishsiz ishlaydi", async () => {
    const sessionId = await createSession("01H555HH", 5000, 61);
    const candidateId = await createPendingExitCandidate("01H555HH", sessionId);
    const response = await confirmCandidate(candidateId);
    expect(response.status).toBe(200);
    const session = await db("tb_parking_sessions").where({ id: sessionId }).first();
    expect(Number(session.amount)).toBe(10000);
    const payment = await db("tb_payments").where({ session_id: sessionId }).first();
    expect(Number(payment.amount)).toBe(10000);
  });

  it("10. kunlik expiry: eskirgan pending discount'lar expired bo'ladi", async () => {
    const yesterday = DateTime.now().setZone("Asia/Tashkent").minus({ days: 1 }).toJSDate();
    const [oldId] = await db("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: "01I666II",
      discount_percent: 20,
      status: "pending",
      created_at: yesterday,
    });
    const [freshId] = await db("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: "01J777JJ",
      discount_percent: 20,
      status: "pending",
    });
    await runClinicDiscountsExpiry();
    const old = await db("tb_clinic_discounts").where({ id: oldId }).first();
    const fresh = await db("tb_clinic_discounts").where({ id: freshId }).first();
    expect(old.status).toBe("expired");
    expect(fresh.status).toBe("pending");
  });

  it("11. kunlik expiry: muddati o'tgan inpatient vehicle'lar expired bo'ladi", async () => {
    const yesterday = DateTime.now().setZone("Asia/Tashkent").minus({ days: 1 }).toFormat("yyyy-MM-dd");
    const tomorrow = DateTime.now().setZone("Asia/Tashkent").plus({ days: 1 }).toFormat("yyyy-MM-dd");
    const [oldId] = await db("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: "01K888KK",
      valid_from: yesterday,
      valid_until: yesterday,
      status: "active",
    });
    const [activeId] = await db("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: "01L999LL",
      valid_from: DateTime.now().toFormat("yyyy-MM-dd"),
      valid_until: tomorrow,
      status: "active",
    });
    await runInpatientVehiclesExpiry();
    const old = await db("tb_inpatient_vehicles").where({ id: oldId }).first();
    const active = await db("tb_inpatient_vehicles").where({ id: activeId }).first();
    expect(old.status).toBe("expired");
    expect(active.status).toBe("active");
  });

  it("12. clinic-discount-settings: 0-100 oralig'idan tashqari qiymat rad etiladi", async () => {
    const invalid = await request(app)
      .patch(`/api/organizations/${orgId}/clinic-discount-settings`)
      .set("Authorization", authorization(owner))
      .send({ clinic_discount_percent: 150 });
    expect(invalid.status).toBe(400);
    const valid = await request(app)
      .patch(`/api/organizations/${orgId}/clinic-discount-settings`)
      .set("Authorization", authorization(owner))
      .send({ clinic_discount_percent: 35 });
    expect(valid.status).toBe(200);
    expect(valid.body.clinic_discount_percent).toBe(35);
  });

  it("13. cross-org isolation: boshqa org'ning discount/inpatient yozuvlariga kirish 404", async () => {
    const discountsResponse = await request(app)
      .get(`/api/organizations/${orgId}/clinic-discounts`)
      .set("Authorization", authorization(otherOwner));
    expect(discountsResponse.status).toBe(404);
    const inpatientResponse = await request(app)
      .get(`/api/organizations/${orgId}/inpatient-vehicles`)
      .set("Authorization", authorization(otherOwner));
    expect(inpatientResponse.status).toBe(404);
  });
});
