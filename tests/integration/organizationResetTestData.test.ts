import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, MockedFunction, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import cameraRelaySettingsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import { runBackup } from "@/scripts/backup";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestSubscription,
  createTestUser,
  createTestVipVehicle,
  setOrgCapacity,
} from "./helpers";

vi.mock("@/scripts/backup", () => ({ runBackup: vi.fn() }));

interface SeededData {
  sessionId: number;
  entryCandidateId: number;
  exitCandidateId: number;
}

interface ActivityLogRow {
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  details: string | Record<string, unknown> | null;
}

const app = express();
app.use(express.json());
app.use("/api/organizations", cameraRelaySettingsRouter);
app.use("/api/parking", parkingRouter);
app.use(errorHandler);

const backupMock = runBackup as MockedFunction<typeof runBackup>;
const testRequest: typeof request = request;

let orgId: number;
let otherOrgId: number;
let ownerId: number;
let otherOwnerId: number;
let superAdminId: number;
let superAdmin: AuthTokenPayload;
let owner: AuthTokenPayload;

function authHeader(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function seedOrganizationData(targetOrgId: number, actorId: number, suffix: string): Promise<SeededData> {
  const plate = `RST${suffix}`;
  const sessionId = await createTestActiveSession(targetOrgId, plate);
  await db("tb_payments").insert({
    org_id: targetOrgId,
    session_id: sessionId,
    amount: 5000,
    payment_method: "cash",
    paid_at: new Date(),
  });
  await db("tb_payment_transactions").insert({
    org_id: targetOrgId,
    session_id: sessionId,
    provider: "payme",
    provider_transaction_id: `reset-${targetOrgId}-${suffix}`,
    amount: 5000,
    state: "created",
  });
  const [entryEventId] = await db("tb_webhook_events").insert({
    org_id: targetOrgId,
    plate_number: plate,
    direction: "entry",
    camera_event_at: new Date(),
  });
  const [exitEventId] = await db("tb_webhook_events").insert({
    org_id: targetOrgId,
    plate_number: plate,
    direction: "exit",
    camera_event_at: new Date(),
    session_id: sessionId,
  });
  const [entryCandidateId] = await db("tb_entry_candidates").insert({
    org_id: targetOrgId,
    webhook_event_id: entryEventId,
    detected_plate: plate,
    confidence: 90,
    camera_event_at: new Date(),
    reason: "capacity_full",
  });
  const [exitCandidateId] = await db("tb_exit_candidates").insert({
    org_id: targetOrgId,
    webhook_event_id: exitEventId,
    detected_plate: plate,
    matched_session_id: sessionId,
    confidence: 90,
    camera_event_at: new Date(),
  });
  await db("tb_webhook_debug_logs").insert({
    org_id: targetOrgId,
    direction: "entry",
    headers: JSON.stringify({}),
    body: JSON.stringify({ test: true }),
  });
  await db("tb_activity_logs").insert({
    actor_id: actorId,
    action: "parking.test_seeded",
    target_type: "session",
    target_id: sessionId,
    details: JSON.stringify({ orgId: targetOrgId }),
  });
  await createTestSubscription(targetOrgId, `SUB${suffix}`);
  await createTestVipVehicle(targetOrgId, `VIP${suffix}`);
  return { sessionId, entryCandidateId, exitCandidateId };
}

async function resetRequest(confirmation: string, actor = superAdmin): Promise<request.Response> {
  return testRequest(app)
    .post(`/api/organizations/${orgId}/reset-test-data`)
    .set("Authorization", authHeader(actor))
    .send({ confirmation });
}

async function tableCount(table: string, targetOrgId: number): Promise<number> {
  const [{ count }] = await db(table).where({ org_id: targetOrgId }).count<{ count: string }[]>("id as count");
  return Number(count);
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const otherOwner = await createTestUser(otherOrgId, { role: "owner" });
  const adminUser = await createTestUser(null, { role: "super_admin" });
  ownerId = ownerUser.id;
  otherOwnerId = otherOwner.id;
  superAdminId = adminUser.id;
  superAdmin = { id: superAdminId, org_id: null, role: "super_admin" };
  owner = { id: ownerId, org_id: orgId, role: "owner" };
  await setOrgCapacity(orgId, 30);
  await setOrgCapacity(otherOrgId, 40);
  await seedOrganizationData(orgId, ownerId, "100");
  await seedOrganizationData(otherOrgId, otherOwnerId, "200");
  backupMock.mockReset();
  backupMock.mockResolvedValue("/var/backups/stoyanka_db_reset.sql.gz");
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await db("tb_users").where({ id: superAdminId }).del();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("organization test data reset", () => {
  it("confirmation RESET bo'lmasa 400 qaytaradi va ma'lumotlarni o'chirmaydi", async () => {
    const response = await resetRequest("reset");
    expect(response.status).toBe(400);
    expect(await tableCount("tb_parking_sessions", orgId)).toBe(1);
    expect(backupMock).not.toHaveBeenCalled();
  });

  it("Super Admin bo'lmagan foydalanuvchiga 403 qaytaradi", async () => {
    const response = await resetRequest("RESET", owner);
    expect(response.status).toBe(403);
    expect(await tableCount("tb_parking_sessions", orgId)).toBe(1);
    expect(backupMock).not.toHaveBeenCalled();
  });

  it("backup muvaffaqiyatsiz bo'lsa transaction hech narsani o'chirmaydi", async () => {
    backupMock.mockRejectedValueOnce(new Error("mysqldump failed"));
    const response = await resetRequest("RESET");
    expect(response.status).toBe(500);
    expect(await tableCount("tb_parking_sessions", orgId)).toBe(1);
    expect(await tableCount("tb_webhook_events", orgId)).toBe(2);
    const activityLog = await db("tb_activity_logs")
      .where({ actor_id: ownerId, action: "parking.test_seeded" })
      .first();
    expect(activityLog).toBeTruthy();
  });

  it("muvaffaqiyatli reset shu organization operatsion jadvallarini tozalaydi", async () => {
    const response = await resetRequest("RESET");
    expect(response.status).toBe(200);
    expect(response.body.deletedCounts).toMatchObject({
      sessions: 1,
      payments: 1,
      paymentTransactions: 1,
      entryCandidates: 1,
      exitCandidates: 1,
      webhookEvents: 2,
      webhookDebugLogs: 1,
      activityLogs: 1,
    });
    for (const table of [
      "tb_parking_sessions",
      "tb_payments",
      "tb_payment_transactions",
      "tb_entry_candidates",
      "tb_exit_candidates",
      "tb_webhook_events",
      "tb_webhook_debug_logs",
    ]) {
      expect(await tableCount(table, orgId)).toBe(0);
    }
    const [{ count: activePlateKeys }] = await db("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereNotNull("active_plate_key")
      .count<{ count: string }[]>("id as count");
    expect(Number(activePlateKeys)).toBe(0);
  });

  it("subscription va VIP yozuvlarini saqlab qoladi", async () => {
    await resetRequest("RESET");
    expect(await tableCount("tb_subscriptions", orgId)).toBe(1);
    expect(await tableCount("tb_vip_vehicles", orgId)).toBe(1);
  });

  it("boshqa organization ma'lumotlariga tegmaydi", async () => {
    await resetRequest("RESET");
    expect(await tableCount("tb_parking_sessions", otherOrgId)).toBe(1);
    expect(await tableCount("tb_payments", otherOrgId)).toBe(1);
    expect(await tableCount("tb_payment_transactions", otherOrgId)).toBe(1);
    expect(await tableCount("tb_entry_candidates", otherOrgId)).toBe(1);
    expect(await tableCount("tb_exit_candidates", otherOrgId)).toBe(1);
    expect(await tableCount("tb_webhook_events", otherOrgId)).toBe(2);
    expect(await tableCount("tb_webhook_debug_logs", otherOrgId)).toBe(1);
    const otherActivityLog = await db("tb_activity_logs")
      .where({ actor_id: otherOwnerId, action: "parking.test_seeded" })
      .first();
    expect(otherActivityLog).toBeTruthy();
  });

  it("resetdan keyin capacity 0/30/30 qaytaradi", async () => {
    await resetRequest("RESET");
    const response = await testRequest(app)
      .get(`/api/parking/capacity?org_id=${orgId}`)
      .set("Authorization", authHeader(superAdmin));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ occupied: 0, total: 30, available: 30 });
  });

  it("reset tugagach yangi activity logni backup va deletedCounts bilan yozadi", async () => {
    const response = await resetRequest("RESET");
    const log = await db<ActivityLogRow>("tb_activity_logs")
      .where({ action: "organization.test_data_reset", target_type: "organization", target_id: orgId })
      .first();
    if (!log) throw new Error("Reset activity log topilmadi");
    const details = typeof log.details === "string" ? JSON.parse(log.details) : log.details;
    expect(log.actor_id).toBe(superAdminId);
    expect(details).toEqual({
      backupPath: "/var/backups/stoyanka_db_reset.sql.gz",
      deletedCounts: response.body.deletedCounts,
    });
  });
});
