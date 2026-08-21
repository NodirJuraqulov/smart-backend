import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { confirmExitCandidate } from "@/modules/exitCandidates/exitCandidates.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import { openBarrier } from "@/modules/relay/relay.service";
import { ledService } from "@/modules/led/led.service";
import { emitExitCompleted, emitRelayFailed } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
  createTestVipVehicle,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true, detail: "opened" }),
}));

vi.mock("@/modules/led/led.service", () => ({
  ledService: {
    showPayment: vi.fn().mockResolvedValue(undefined),
    showPlateOnly: vi.fn().mockResolvedValue(undefined),
    scheduleReturnToClock: vi.fn(),
  },
}));

vi.mock("@/modules/telegram/telegram.service", () => ({
  telegramService: {
    sendExitNotification: vi.fn().mockResolvedValue(undefined),
  },
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
  emitPublicEntryStatusChanged: vi.fn(),
  emitPublicExitStatusChanged: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

interface SessionRow {
  id: number;
  status: string;
  amount: string | number | null;
  exit_method: string | null;
  exited_at: Date | null;
  active_plate_key: string | null;
}

interface ActivityLogRow {
  actor_id: number | null;
  action: string;
  target_type: string;
  target_id: number;
  details: Record<string, unknown>;
}

let orgId: number;
let webhookToken: string;
let jpegBase64: string;

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;
const openBarrierMock = openBarrier as unknown as ReturnType<typeof vi.fn>;

function dahuaExitBody(plate: string) {
  return {
    Picture: { NormalPic: { Content: jpegBase64, PicName: `${plate}.jpg` } },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 94 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "auto-exit-camera", SnapTime: new Date().toISOString() },
  };
}

async function postExit(plate: string) {
  return testRequest(app)
    .post(`/api/webhook/camera/${webhookToken}/exit`)
    .set("Content-Type", "application/json")
    .send(dahuaExitBody(plate));
}

async function createSession(plate: string, source: "regular" | "vip" = "regular"): Promise<number> {
  const id = await createTestActiveSession(orgId, plate, new Date(Date.now() - 90 * 60_000));
  await testDb("tb_parking_sessions").where({ id }).update({
    session_source: source,
    tariff_price_per_hour: source === "regular" ? 5000 : null,
    tariff_grace_period_minutes: source === "regular" ? 0 : null,
  });
  return id;
}

async function addInpatient(plate: string, validUntilOffsetDays = 3): Promise<number> {
  const today = DateTime.now().setZone("Asia/Tashkent");
  const [id] = await testDb("tb_inpatient_vehicles").insert({
    org_id: orgId,
    plate_number: plate,
    valid_from: today.toFormat("yyyy-MM-dd"),
    valid_until: today.plus({ days: validUntilOffsetDays }).toFormat("yyyy-MM-dd"),
    status: "active",
  });
  return id;
}

async function addClinicDiscount(plate: string, percent: number): Promise<number> {
  const [id] = await testDb("tb_clinic_discounts").insert({
    org_id: orgId,
    plate_number: plate,
    discount_percent: percent,
    status: "pending",
  });
  return id;
}

async function sessionById(id: number): Promise<SessionRow> {
  const session = await testDb<SessionRow>("tb_parking_sessions").where({ id }).first();
  if (!session) throw new Error(`Sessiya topilmadi: ${id}`);
  return session;
}

async function autoExitLogs(sessionId: number): Promise<ActivityLogRow[]> {
  return testDb<ActivityLogRow>("tb_activity_logs")
    .where({ action: "auto_exit_no_operator", target_type: "session", target_id: sessionId })
    .orderBy("id", "asc");
}

async function candidates() {
  return testDb("tb_exit_candidates").where({ org_id: orgId });
}

async function expireDedupeWindow(): Promise<void> {
  await testDb("tb_webhook_events")
    .where({ org_id: orgId })
    .update({ created_at: testDb.raw("DATE_SUB(NOW(), INTERVAL 20 SECOND)") });
}

async function shiftAutoExitLog(sessionId: number, minutesAgo: number): Promise<void> {
  await testDb("tb_activity_logs")
    .where({ action: "auto_exit_no_operator", target_type: "session", target_id: sessionId })
    .update({ created_at: testDb.raw("DATE_SUB(NOW(), INTERVAL ? MINUTE)", [minutesAgo]) });
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
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `autoexit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await testDb("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  openBarrierMock.mockReset();
  openBarrierMock.mockResolvedValue({ status: "opened", success: true, detail: "opened" });
  vi.clearAllMocks();
  vi.mocked(ledService.showPayment).mockReset().mockResolvedValue(undefined);
  vi.mocked(ledService.showPlateOnly).mockReset().mockResolvedValue(undefined);
  vi.mocked(ledService.scheduleReturnToClock).mockReset();
});

afterEach(async () => {
  await clearWebhookDedupeCache(orgId);
  await fs.rm(path.join(process.cwd(), "uploads", "parking-events", String(orgId)), {
    recursive: true,
    force: true,
  });
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("operatorsiz avtomatik chiqish", () => {
  it("1. VIP mashina operatorsiz avtomatik chiqadi", async () => {
    const sessionId = await createSession("01V500AA", "vip");
    await createTestVipVehicle(orgId, "01V500AA");

    const response = await postExit("01V500AA");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      auto_exit: true,
      reason: "vip",
      session_id: sessionId,
      barrier_status: "opened",
    });

    const session = await sessionById(sessionId);
    expect(session).toMatchObject({ status: "completed", exit_method: "auto", active_plate_key: null });
    expect(Number(session.amount)).toBe(0);
    expect(session.exited_at).not.toBeNull();

    expect(await candidates()).toHaveLength(0);
    expect(await testDb("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(ledService.showPlateOnly).toHaveBeenCalledWith(orgId, "01V500AA");
    expect(ledService.scheduleReturnToClock).toHaveBeenCalledWith(orgId);
    expect(openBarrierMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ledService.showPlateOnly).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(ledService.showPlateOnly).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ledService.scheduleReturnToClock).mock.invocationCallOrder[0]
    );
  });

  it("auto-exit LED xatosi asosiy oqimni to'xtatmaydi", async () => {
    const sessionId = await createSession("01V501AA", "vip");
    await createTestVipVehicle(orgId, "01V501AA");
    const error = new Error("LED connection refused");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(ledService.showPlateOnly).mockRejectedValueOnce(error);

    const response = await postExit("01V501AA");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ auto_exit: true, session_id: sessionId });
    expect((await sessionById(sessionId)).status).toBe("completed");
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
    expect(ledService.scheduleReturnToClock).toHaveBeenCalledWith(orgId);
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("LED_PLATE_FAILED", error);
    });
  });

  it("2. faol statsionar mashina operatorsiz avtomatik chiqadi", async () => {
    const sessionId = await createSession("01S500AA");
    await addInpatient("01S500AA");

    const response = await postExit("01S500AA");
    expect(response.body).toMatchObject({ auto_exit: true, reason: "inpatient", session_id: sessionId });

    const session = await sessionById(sessionId);
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
    expect(await candidates()).toHaveLength(0);
    expect(await testDb("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
  });

  it("3. 100% klinika chegirmasi avtomatik chiqadi va chegirma used bo'ladi", async () => {
    const sessionId = await createSession("01C500AA");
    const discountId = await addClinicDiscount("01C500AA", 100);

    const response = await postExit("01C500AA");
    expect(response.body).toMatchObject({ auto_exit: true, reason: "clinic_discount_100" });

    const session = await sessionById(sessionId);
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);

    const discount = await testDb("tb_clinic_discounts").where({ id: discountId }).first();
    expect(discount).toMatchObject({ status: "used", used_session_id: sessionId });
    expect(discount.used_at).not.toBeNull();
  });

  it("4. 50% klinika chegirmasi avtomatik ISHLAMAYDI, operator tasdig'i kerak", async () => {
    const sessionId = await createSession("01C600AA");
    const discountId = await addClinicDiscount("01C600AA", 50);

    const response = await postExit("01C600AA");
    expect(response.body.auto_exit).toBeUndefined();
    expect(response.body.candidate_created).toBe(true);

    const session = await sessionById(sessionId);
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ detected_plate: "01C600AA", matched_session_id: sessionId });

    const discount = await testDb("tb_clinic_discounts").where({ id: discountId }).first();
    expect(discount.status).toBe("pending");
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("5. oddiy mashina o'zgarishsiz operator tasdig'ini talab qiladi", async () => {
    const sessionId = await createSession("01N500AA");

    const response = await postExit("01N500AA");
    expect(response.body.auto_exit).toBeUndefined();
    expect(response.body.candidate_created).toBe(true);

    expect((await sessionById(sessionId)).status).toBe("active");
    expect(await candidates()).toHaveLength(1);
    expect(openBarrier).not.toHaveBeenCalled();
    expect(await autoExitLogs(sessionId)).toHaveLength(0);
  });

  it("6. mos sessiya bo'lmasa VIP bo'lsa ham avtomatik ishlamaydi", async () => {
    await createTestVipVehicle(orgId, "01V600AA");

    const response = await postExit("01V600AA");
    expect(response.body.auto_exit).toBeUndefined();
    expect(response.body.candidate_created).toBe(true);

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0].matched_session_id).toBeNull();
    expect(openBarrier).not.toHaveBeenCalled();
  });

  it("7. ham VIP ham 100% chegirma bo'lsa faqat ustuvor sabab qo'llanadi", async () => {
    const sessionId = await createSession("01M500AA", "vip");
    await createTestVipVehicle(orgId, "01M500AA");
    const discountId = await addClinicDiscount("01M500AA", 100);
    await addInpatient("01M500AA");

    const response = await postExit("01M500AA");
    expect(response.body).toMatchObject({ auto_exit: true, reason: "inpatient" });

    const logs = await autoExitLogs(sessionId);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ reason: "inpatient" });

    const discount = await testDb("tb_clinic_discounts").where({ id: discountId }).first();
    expect(discount.status).toBe("pending");
  });

  it("8. avtomatik chiqish activity log'ga to'g'ri yoziladi", async () => {
    const sessionId = await createSession("01V700AA", "vip");
    await createTestVipVehicle(orgId, "01V700AA");

    await postExit("01V700AA");

    const logs = await autoExitLogs(sessionId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor_id: null,
      action: "auto_exit_no_operator",
      target_type: "session",
      target_id: sessionId,
    });
    expect(logs[0].details).toMatchObject({
      orgId,
      sessionId,
      plateNumber: "01V700AA",
      reason: "vip",
    });

    const barrierAudit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({ action: "parking.exit_candidate_barrier_opened", target_type: "session", target_id: sessionId })
      .first();
    expect(barrierAudit).toBeTruthy();
    expect(barrierAudit!.details).toMatchObject({ barrierStatus: "opened", candidateId: null, sessionId });
  });

  it("9. avtomatik chiqishda exit_completed socket eventi yuboriladi", async () => {
    const sessionId = await createSession("01V800AA", "vip");
    await createTestVipVehicle(orgId, "01V800AA");

    await postExit("01V800AA");

    expect(emitExitCompleted).toHaveBeenCalledTimes(1);
    expect(emitExitCompleted).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        orgId,
        sessionId,
        plateNumber: "01V800AA",
        amount: 0,
        paymentMethod: null,
        barrierStatus: "opened",
        sessionSource: "vip",
      })
    );
  });

  it("10. shlagbaum ochilmasa ham sessiya yopiladi va xato log'ga tushadi", async () => {
    const sessionId = await createSession("01V900AA", "vip");
    await createTestVipVehicle(orgId, "01V900AA");
    openBarrierMock.mockResolvedValueOnce({ status: "failed", success: false, detail: "relay timeout" });

    const response = await postExit("01V900AA");
    expect(response.body).toMatchObject({ auto_exit: true, barrier_status: "failed" });

    const session = await sessionById(sessionId);
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);

    const failedAudit = await testDb<ActivityLogRow>("tb_activity_logs")
      .where({
        action: "parking.exit_candidate_barrier_open_failed",
        target_type: "session",
        target_id: sessionId,
      })
      .first();
    expect(failedAudit).toBeTruthy();
    expect(failedAudit!.details).toMatchObject({ barrierStatus: "failed", sessionId });

    expect(emitRelayFailed).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ direction: "exit", plateNumber: "01V900AA" })
    );
    expect(await autoExitLogs(sessionId)).toHaveLength(1);
  });

  it("11. avtomatik chiqishdan keyin takroriy webhook candidate yaratmaydi", async () => {
    const sessionId = await createSession("01V950AA", "vip");
    await createTestVipVehicle(orgId, "01V950AA");

    expect((await postExit("01V950AA")).body.auto_exit).toBe(true);
    await expireDedupeWindow();
    await shiftAutoExitLog(sessionId, 2);
    vi.mocked(ledService.showPlateOnly).mockClear();
    vi.mocked(ledService.showPayment).mockClear();
    vi.mocked(ledService.scheduleReturnToClock).mockClear();

    const second = await postExit("01V950AA");
    expect(second.body).toMatchObject({
      ignored: true,
      reason: "duplicate_after_auto_exit",
    });
    expect(second.body.candidate_created).toBeUndefined();

    expect(await candidates()).toHaveLength(0);
    expect(await autoExitLogs(sessionId)).toHaveLength(1);
    expect(ledService.showPlateOnly).not.toHaveBeenCalled();
    expect(ledService.showPayment).not.toHaveBeenCalled();
    expect(ledService.scheduleReturnToClock).not.toHaveBeenCalled();

    const event = await testDb("tb_webhook_events").where({ org_id: orgId }).orderBy("id", "desc").first();
    expect(event).toMatchObject({
      processing_result: "duplicate_after_auto_exit",
      processing_reason: "auto_exit_cooldown",
    });
    expect(event.processed_at).not.toBeNull();
  });

  it("12. 10 daqiqadan keyin cooldown tugaydi, odatdagi candidate oqimi tiklanadi", async () => {
    const sessionId = await createSession("01V960AA", "vip");
    await createTestVipVehicle(orgId, "01V960AA");

    expect((await postExit("01V960AA")).body.auto_exit).toBe(true);
    await expireDedupeWindow();
    await shiftAutoExitLog(sessionId, 11);

    const second = await postExit("01V960AA");
    expect(second.body.candidate_created).toBe(true);
    expect(second.body.reason).toBeUndefined();

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0].detected_plate).toBe("01V960AA");
  });

  it("13. operator tasdiqlagan chiqish uchun mavjud cooldown o'zgarishsiz ishlaydi", async () => {
    const sessionId = await createSession("01N600AA");
    const user = await createTestUser(orgId, { role: "owner" });
    const actor: AuthTokenPayload = { id: user.id, org_id: orgId, role: "owner" };

    const first = await postExit("01N600AA");
    expect(first.body.candidate_created).toBe(true);

    const candidate = await testDb("tb_exit_candidates").where({ org_id: orgId }).first();
    await confirmExitCandidate(actor, orgId, candidate.id, { paymentMethod: "cash" });

    expect((await sessionById(sessionId)).status).toBe("completed");
    expect(await autoExitLogs(sessionId)).toHaveLength(0);

    await expireDedupeWindow();
    vi.mocked(ledService.showPlateOnly).mockClear();
    vi.mocked(ledService.showPayment).mockClear();
    vi.mocked(ledService.scheduleReturnToClock).mockClear();
    const second = await postExit("01N600AA");
    expect(second.body).toMatchObject({
      ignored: true,
      reason: "resolved_recently_ignored",
    });
    expect(await candidates()).toHaveLength(1);
    expect(ledService.showPlateOnly).not.toHaveBeenCalled();
    expect(ledService.showPayment).not.toHaveBeenCalled();
    expect(ledService.scheduleReturnToClock).not.toHaveBeenCalled();
  });
});
