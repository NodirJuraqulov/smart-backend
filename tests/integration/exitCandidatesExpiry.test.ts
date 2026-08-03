import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import { runExitCandidatesExpiry } from "@/jobs/exitCandidatesExpiryJob";
import organizationsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import { emitExitCandidateResolved } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

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
app.use("/api/organizations", organizationsRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

let orgId: number;
let superAdminId: number;
let superAdmin: AuthTokenPayload;
let owner: AuthTokenPayload;

const emitExitCandidateResolvedMock = emitExitCandidateResolved as unknown as ReturnType<typeof vi.fn>;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createPendingCandidate(createdAt: Date, plate: string | null): Promise<number> {
  const [webhookEventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plate,
    direction: "exit",
    camera_event_at: createdAt,
    processing_result: "exit_candidate_pending",
    created_at: createdAt,
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: plate,
    confidence: 80,
    camera_event_at: createdAt,
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
  });
  return candidateId;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdminId = adminUser.id;
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  emitExitCandidateResolvedMock.mockClear();
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await db("tb_users").where({ id: superAdminId }).del();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("exit candidate expiry", () => {
  it("1. 10 daqiqadan eski pending exit candidate avtomatik expired bo'ladi", async () => {
    const now = new Date();
    const expiredId = await createPendingCandidate(new Date(now.getTime() - 11 * 60_000), "01E100AA");
    const freshId = await createPendingCandidate(new Date(now.getTime() - 9 * 60_000), "01E101AA");
    expect(await runExitCandidatesExpiry(now)).toBe(1);
    expect(await db("tb_exit_candidates").where({ id: expiredId }).first()).toMatchObject({
      status: "expired",
      resolution_note: "Avtomatik muddati tugadi (10 daqiqa javob berilmadi)",
    });
    expect(await db("tb_exit_candidates").where({ id: freshId }).first()).toMatchObject({ status: "pending" });
    expect(emitExitCandidateResolvedMock).toHaveBeenCalledWith(orgId, {
      candidateId: expiredId,
      orgId,
      status: "expired",
      resolutionType: null,
      sessionId: null,
      barrierStatus: null,
      plateNumber: "01E100AA",
    });
  });

  it("2. expired exit candidate next endpoint orqali qaytmaydi", async () => {
    const now = new Date();
    await createPendingCandidate(new Date(now.getTime() - 11 * 60_000), "01E200AA");
    await runExitCandidatesExpiry(now);
    const response = await request(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", authorization(owner));
    expect(response.status).toBe(204);
    expect(response.text).toBe("");
  });

  it("3. Super Admin endpointi organizationdagi barcha pending candidate'larni expired qiladi", async () => {
    const firstId = await createPendingCandidate(new Date(Date.now() - 60_000), "01E300AA");
    const secondId = await createPendingCandidate(new Date(), null);
    const response = await request(app)
      .post(`/api/organizations/${orgId}/expire-stale-exit-candidates`)
      .set("Authorization", authorization(superAdmin))
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ expiredCount: 2 });
    const candidates = await db("tb_exit_candidates").whereIn("id", [firstId, secondId]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.status === "expired")).toBe(true);
    expect(
      candidates.every((candidate) => candidate.resolution_note === "Qo'lda tozalandi (deploy oldidan)")
    ).toBe(true);
    const activity = await db("tb_activity_logs")
      .where({
        actor_id: superAdminId,
        action: "organization.exit_candidates_expired",
        target_type: "organization",
        target_id: orgId,
      })
      .first();
    expect(activity).toBeTruthy();
    const details = typeof activity.details === "string" ? JSON.parse(activity.details) : activity.details;
    expect(details).toMatchObject({ orgId, expiredCount: 2 });
  });

  it("4. Super Admin bo'lmagan foydalanuvchi tozalash endpointini chaqira olmaydi", async () => {
    const candidateId = await createPendingCandidate(new Date(), "01E400AA");
    const response = await request(app)
      .post(`/api/organizations/${orgId}/expire-stale-exit-candidates`)
      .set("Authorization", authorization(owner))
      .send({});
    expect(response.status).toBe(403);
    expect(await db("tb_exit_candidates").where({ id: candidateId }).first()).toMatchObject({
      status: "pending",
    });
  });
});
