import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import forcedOpenAuditRouter from "@/modules/forcedOpenAudit/forcedOpenAudit.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/forced-open-audit", forcedOpenAuditRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let operator: AuthTokenPayload;
let otherOperator: AuthTokenPayload;
let kassir: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createSession(input: {
  orgId?: number;
  plate: string;
  enteredAt: Date;
  status?: "active" | "completed";
  exitedAt?: Date | null;
  amount?: number | null;
  exitMethod?: "forced" | "emergency" | null;
  pricePerHour?: number | null;
}): Promise<number> {
  const targetOrgId = input.orgId ?? orgId;
  const status = input.status ?? "active";
  const [id] = await db("tb_parking_sessions").insert({
    org_id: targetOrgId,
    plate_number: input.plate,
    entered_at: input.enteredAt,
    exited_at: input.exitedAt ?? null,
    status,
    entry_method: "auto",
    exit_method: input.exitMethod ?? null,
    session_source: "regular",
    amount: input.amount ?? null,
    tariff_price_per_hour: input.pricePerHour === undefined ? 6000 : input.pricePerHour,
    tariff_grace_period_minutes: 0,
    active_plate_key: status === "active" ? `${targetOrgId}:${input.plate}:${Date.now()}:${Math.random()}` : null,
  });
  return id;
}

async function createCandidate(input: {
  orgId?: number;
  operatorId?: number;
  forcedAt: Date;
  plate?: string | null;
  confidence?: number | null;
  sessionId?: number | null;
  matchedSessionId?: number | null;
  resolutionType?: "forced_open" | "emergency_forced_open" | "exact";
  withImage?: boolean;
}): Promise<{ candidateId: number; eventId: number }> {
  const targetOrgId = input.orgId ?? orgId;
  const [eventId] = await db("tb_webhook_events").insert({
    org_id: targetOrgId,
    plate_number: input.plate ?? null,
    direction: "exit",
    camera_event_at: input.forcedAt,
    overview_image_path: input.withImage ? `uploads/parking-events/${targetOrgId}/test.jpg` : null,
  });
  const resolutionType = input.resolutionType ?? "forced_open";
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: targetOrgId,
    webhook_event_id: eventId,
    detected_plate: input.plate ?? null,
    confidence: input.confidence ?? null,
    camera_event_at: input.forcedAt,
    status: resolutionType === "exact" ? "accepted" : "dismissed",
    resolution_type: resolutionType,
    resolved_by: input.operatorId ?? operator.id,
    resolved_at: input.forcedAt,
    resolved_session_id: input.sessionId ?? null,
    matched_session_id: input.matchedSessionId ?? null,
  });
  return { candidateId, eventId };
}

async function createStoredReview(input: {
  orgId?: number;
  candidateId: number;
  sessionId: number;
  forcedAt: Date;
}): Promise<number> {
  const [id] = await db("forced_open_reviews").insert({
    org_id: input.orgId ?? orgId,
    candidate_id: input.candidateId,
    operator_id: operator.id,
    operator_name: "Smena Operatori",
    forced_at: input.forcedAt,
    session_id: input.sessionId,
    amount_som: 6000,
    kind: "session_found",
    saved_by: owner.id,
  });
  return id;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const otherOperatorUser = await createTestUser(orgId, { role: "operator" });
  const kassirUser = await createTestUser(orgId, { role: "kassir" });
  const superAdminUser = await createTestUser(null, { role: "super_admin" });
  await db("tb_users").where({ id: operatorUser.id }).update({ name: "Smena Operatori" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  otherOperator = { id: otherOperatorUser.id, org_id: orgId, role: "operator" };
  kassir = { id: kassirUser.id, org_id: orgId, role: "kassir" };
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await db("tb_users").where({ id: superAdmin.id }).del();
});

afterAll(async () => {
  await closeDb();
});

describe("forced-open audit owner API", () => {
  it("smena chegarasi va operator bo'yicha not_found hamda session_found yozuvlarini tarif summasi bilan qaytaradi", async () => {
    await createCandidate({ forcedAt: new Date("2026-10-30T02:59:59.000Z"), plate: "01OLD001" });
    const notFound = await createCandidate({
      forcedAt: new Date("2026-10-30T03:00:00.000Z"),
      plate: "01A123BC",
      confidence: 86,
      withImage: true,
    });
    const sessionId = await createSession({
      plate: "01B777BB",
      enteredAt: new Date("2026-10-30T01:30:00.000Z"),
      status: "completed",
      exitedAt: new Date("2026-10-30T03:05:00.000Z"),
      amount: 0,
      exitMethod: "forced",
    });
    const sessionFound = await createCandidate({
      forcedAt: new Date("2026-10-30T03:05:00.000Z"),
      plate: "01B777BB",
      sessionId,
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T03:10:00.000Z"),
      plate: "01OTHER1",
      operatorId: otherOperator.id,
    });
    await db("forced_open_reviews").insert({
      org_id: orgId,
      candidate_id: notFound.candidateId,
      operator_id: operator.id,
      operator_name: "Smena Operatori",
      forced_at: new Date("2026-10-30T03:00:00.000Z"),
      detected_plate: "01A123BC",
      webhook_event_id: notFound.eventId,
      session_id: null,
      session_plate: null,
      entered_at: null,
      duration_minutes: null,
      amount_som: 0,
      kind: "not_found",
      saved_by: owner.id,
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        candidate_id: notFound.candidateId,
        forced_at: "2026-10-30T03:00:00.000Z",
        detected_plate: "01A123BC",
        confidence: 86,
        webhook_event_id: notFound.eventId,
        has_image: true,
        image_url: `/api/webhook-events/${notFound.eventId}/images/overview`,
        kind: "not_found",
        session: null,
        review_id: expect.any(Number),
      },
      {
        candidate_id: sessionFound.candidateId,
        forced_at: "2026-10-30T03:05:00.000Z",
        detected_plate: "01B777BB",
        confidence: null,
        webhook_event_id: sessionFound.eventId,
        has_image: false,
        image_url: null,
        kind: "session_found",
        session: {
          session_id: sessionId,
          plate_number: "01B777BB",
          entered_at: "2026-10-30T01:30:00.000Z",
          duration_minutes: 95,
          amount_som: 12000,
          forced_closed: true,
        },
        review_id: null,
      },
    ]);
  });

  it("majburiy parametrlarni tekshiradi va boshqa resolution turini kiritmaydi", async () => {
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01EXACT1",
      resolutionType: "exact",
    });

    const missing = await request(app)
      .get("/api/forced-open-audit")
      .set("Authorization", authorization(owner));
    const listed = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(missing.status).toBe(400);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });

  it("not_found nomzod uchun canonical masofa ikki qidiruvini org va forced_at bilan cheklaydi", async () => {
    const forcedAt = new Date("2026-10-30T05:00:00.000Z");
    const candidate = await createCandidate({ forcedAt, plate: "01O123AA" });
    const exactId = await createSession({
      plate: "010123AA",
      enteredAt: new Date("2026-10-30T02:00:00.000Z"),
    });
    const fuzzyId = await createSession({
      plate: "010123AB",
      enteredAt: new Date("2026-10-30T02:30:00.000Z"),
    });
    await createSession({
      orgId: otherOrgId,
      plate: "010123AA",
      enteredAt: new Date("2026-10-30T02:00:00.000Z"),
    });
    await createSession({
      plate: "010123AA",
      enteredAt: new Date("2026-10-30T05:00:01.000Z"),
    });

    const response = await request(app)
      .post("/api/forced-open-audit/search")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, plate: "01O123AA" });

    expect(response.status).toBe(200);
    expect(response.body.map((item: { session_id: number }) => item.session_id)).toEqual([exactId, fuzzyId]);
    expect(response.body[0]).toEqual({
      session_id: exactId,
      plate_number: "010123AA",
      entered_at: "2026-10-30T02:00:00.000Z",
      duration_minutes: 180,
      amount_som: 18000,
      similarity: 100,
    });
  });

  it("search session_found nomzodni 409 bilan rad etadi", async () => {
    const sessionId = await createSession({
      plate: "01A111AA",
      enteredAt: new Date("2026-10-30T02:00:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01A111AA",
      sessionId,
    });

    const response = await request(app)
      .post("/api/forced-open-audit/search")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, plate: "01A111AA" });

    expect(response.status).toBe(409);
  });

  it("faqat matched_session_id bor nomzodni session_found deb qaytaradi va qidiruvni rad etadi", async () => {
    const matchedSessionId = await createSession({
      plate: "01MATCH1",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01MATCH1",
      matchedSessionId,
    });

    const listed = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));
    const searched = await request(app)
      .post("/api/forced-open-audit/search")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, plate: "01MATCH1" });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidateId,
        kind: "session_found",
        session: {
          session_id: matchedSessionId,
          plate_number: "01MATCH1",
          entered_at: "2026-10-30T01:00:00.000Z",
          duration_minutes: 240,
          amount_som: 24000,
          forced_closed: false,
        },
      }),
    ]);
    expect(searched.status).toBe(409);
  });

  it("resolved sessiyani matched sessiyadan ustun qo'yadi", async () => {
    const matchedSessionId = await createSession({
      plate: "01MATCH2",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const resolvedSessionId = await createSession({
      plate: "01RESOL2",
      enteredAt: new Date("2026-10-30T03:00:00.000Z"),
      status: "completed",
      exitedAt: new Date("2026-10-30T05:00:00.000Z"),
      amount: 0,
      exitMethod: "forced",
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01RESOL2",
      sessionId: resolvedSessionId,
      matchedSessionId,
    });

    const listed = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));
    const saved = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        candidate_id: candidate.candidateId,
        kind: "session_found",
        session: expect.objectContaining({
          session_id: resolvedSessionId,
          plate_number: "01RESOL2",
          duration_minutes: 120,
          amount_som: 12000,
          forced_closed: true,
        }),
      }),
    ]);
    expect(saved.status).toBe(201);
    expect(saved.body).toEqual(expect.objectContaining({
      session_id: resolvedSessionId,
      duration_minutes: 120,
      amount_som: 12000,
      kind: "session_found",
    }));
  });

  it("resolved sessiya boshqa tashkilotda bo'lsa matched sessiyaga fallback qilmaydi", async () => {
    const foreignResolvedSessionId = await createSession({
      orgId: otherOrgId,
      plate: "01FOREI2",
      enteredAt: new Date("2026-10-30T02:00:00.000Z"),
    });
    const matchedSessionId = await createSession({
      plate: "01LOCAL2",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01LOCAL2",
      sessionId: foreignResolvedSessionId,
      matchedSessionId,
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: candidate.candidateId, kind: "not_found", session: null }),
    ]);
  });

  it("sessiya idlari yo'q yoki matched sessiya o'chirilgan bo'lsa not_found qaytaradi", async () => {
    const withoutSession = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01NONE01",
    });
    const deletedSessionId = await createSession({
      plate: "01GONE01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const deletedMatch = await createCandidate({
      forcedAt: new Date("2026-10-30T05:05:00.000Z"),
      plate: "01GONE01",
      matchedSessionId: deletedSessionId,
    });
    await db("tb_parking_sessions").where({ id: deletedSessionId }).del();

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));
    const deletedCandidate = await db("tb_exit_candidates")
      .select("matched_session_id")
      .where({ id: deletedMatch.candidateId })
      .first();

    expect(deletedCandidate.matched_session_id).toBeNull();
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: withoutSession.candidateId, kind: "not_found", session: null }),
      expect.objectContaining({ candidate_id: deletedMatch.candidateId, kind: "not_found", session: null }),
    ]);
  });

  it("boshqa tashkilotdagi matched sessiyani session_found deb hisoblamaydi", async () => {
    const foreignSessionId = await createSession({
      orgId: otherOrgId,
      plate: "01CROSS1",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01CROSS1",
      matchedSessionId: foreignSessionId,
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: candidate.candidateId, kind: "not_found", session: null }),
    ]);
  });

  it("matched sessiyali reviewni server sessiyasi va summasi bilan saqlaydi", async () => {
    const matchedSessionId = await createSession({
      plate: "01SAVE02",
      enteredAt: new Date("2026-10-30T02:30:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01SAVE02",
      matchedSessionId,
    });

    const saved = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, amount_som: 1 });
    const duplicate = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId });

    expect(saved.status).toBe(201);
    expect(saved.body).toEqual(expect.objectContaining({
      candidate_id: candidate.candidateId,
      session_id: matchedSessionId,
      duration_minutes: 150,
      amount_som: 18000,
      kind: "session_found",
    }));
    expect(duplicate.status).toBe(409);
  });

  it("bir sessiyaga bog'langan uchta nomzoddan eng yuqori confidence qatorini qoldiradi", async () => {
    const sessionId = await createSession({
      plate: "01DEDUP1",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01DEDUPA",
      confidence: null,
      matchedSessionId: sessionId,
    });
    const winner = await createCandidate({
      forcedAt: new Date("2026-10-30T04:10:00.000Z"),
      plate: "01DEDUPB",
      confidence: 92,
      matchedSessionId: sessionId,
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:20:00.000Z"),
      plate: "01DEDUPC",
      confidence: 80,
      matchedSessionId: sessionId,
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: winner.candidateId, confidence: 92 }),
    ]);
  });

  it("saqlangan nomzodni confidence va forced_at dan ustun qo'yadi", async () => {
    const sessionId = await createSession({
      plate: "01SAVED1",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const savedCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:20:00.000Z"),
      plate: "01SAVEDA",
      confidence: 10,
      matchedSessionId: sessionId,
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01SAVEDB",
      confidence: 99,
      matchedSessionId: sessionId,
    });
    const reviewId = await createStoredReview({
      candidateId: savedCandidate.candidateId,
      sessionId,
      forcedAt: new Date("2026-10-30T04:20:00.000Z"),
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: savedCandidate.candidateId, review_id: reviewId }),
    ]);
  });

  it("bir sessiyada bir nechta saqlangan nomzod bo'lsa eng erta forced_at ni qoldiradi", async () => {
    const sessionId = await createSession({
      plate: "01HIST01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const early = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01HIST0A",
      confidence: 10,
      matchedSessionId: sessionId,
    });
    const late = await createCandidate({
      forcedAt: new Date("2026-10-30T04:10:00.000Z"),
      plate: "01HIST0B",
      confidence: 99,
      matchedSessionId: sessionId,
    });
    const earlyReviewId = await createStoredReview({
      candidateId: early.candidateId,
      sessionId,
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
    });
    await createStoredReview({
      candidateId: late.candidateId,
      sessionId,
      forcedAt: new Date("2026-10-30T04:10:00.000Z"),
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ candidate_id: early.candidateId, review_id: earlyReviewId }),
    ]);
  });

  it("teng confidence da erta forced_at ni qoldiradi va umumiy tartibni saqlaydi", async () => {
    const sharedSessionId = await createSession({
      plate: "01EARLY1",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const distinctSessionId = await createSession({
      plate: "01DIST01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const notFound = await createCandidate({
      forcedAt: new Date("2026-10-30T03:30:00.000Z"),
      plate: "01NONE02",
    });
    const early = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01EARLYA",
      confidence: 85,
      matchedSessionId: sharedSessionId,
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:10:00.000Z"),
      plate: "01EARLYB",
      confidence: 85,
      matchedSessionId: sharedSessionId,
    });
    const distinct = await createCandidate({
      forcedAt: new Date("2026-10-30T04:20:00.000Z"),
      plate: "01DIST01",
      confidence: 70,
      matchedSessionId: distinctSessionId,
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body.map((item: { candidate_id: number }) => item.candidate_id)).toEqual([
      notFound.candidateId,
      early.candidateId,
      distinct.candidateId,
    ]);
    expect(response.body[0]).toEqual(expect.objectContaining({ kind: "not_found", session: null }));
  });

  it("shu sessiya boshqa nomzod bilan saqlangan bo'lsa saqlanmagan qatorni yashiradi", async () => {
    const sessionId = await createSession({
      plate: "01HIDE01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01HIDE01",
      matchedSessionId: sessionId,
    });
    const savedElsewhere = await createCandidate({
      operatorId: otherOperator.id,
      forcedAt: new Date("2026-10-30T04:05:00.000Z"),
      plate: "01HIDE02",
      matchedSessionId: sessionId,
    });
    await createStoredReview({
      candidateId: savedElsewhere.candidateId,
      sessionId,
      forcedAt: new Date("2026-10-30T04:05:00.000Z"),
    });

    const response = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("bir sessiyani ikki nomzod bilan ketma-ket saqlashda ikkinchisini 409 qiladi", async () => {
    const sessionId = await createSession({
      plate: "01ONCE01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const firstCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01ONCEA",
      matchedSessionId: sessionId,
    });
    const secondCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:05:00.000Z"),
      plate: "01ONCEB",
      matchedSessionId: sessionId,
    });

    const first = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: firstCandidate.candidateId });
    const second = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: secondCandidate.candidateId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ message: "shu sessiya allaqachon saqlangan" });
  });

  it("bir sessiyani ikki nomzod bilan parallel saqlashda bitta review yaratadi", async () => {
    const sessionId = await createSession({
      plate: "01RACE01",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const firstCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01RACE0A",
      matchedSessionId: sessionId,
    });
    const secondCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:05:00.000Z"),
      plate: "01RACE0B",
      matchedSessionId: sessionId,
    });

    const responses = await Promise.all([
      request(app)
        .post("/api/forced-open-audit/reviews")
        .set("Authorization", authorization(owner))
        .send({ candidate_id: firstCandidate.candidateId }),
      request(app)
        .post("/api/forced-open-audit/reviews")
        .set("Authorization", authorization(owner))
        .send({ candidate_id: secondCandidate.candidateId }),
    ]);
    const reviews = await db("forced_open_reviews").where({ org_id: orgId, session_id: sessionId });

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toEqual({
      message: "shu sessiya allaqachon saqlangan",
    });
    expect(reviews).toHaveLength(1);
  });

  it("boshqa tashkilotdagi shu session_id reviewi guruhlash va saqlashga aralashmaydi", async () => {
    const sessionId = await createSession({
      plate: "01ORG001",
      enteredAt: new Date("2026-10-30T01:00:00.000Z"),
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01ORG001",
      matchedSessionId: sessionId,
    });
    const foreignCandidate = await createCandidate({
      orgId: otherOrgId,
      operatorId: (await createTestUser(otherOrgId, { role: "operator" })).id,
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01ORG002",
    });
    await createStoredReview({
      orgId: otherOrgId,
      candidateId: foreignCandidate.candidateId,
      sessionId,
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
    });

    const listed = await request(app)
      .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));
    const saved = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ candidate_id: candidate.candidateId }),
    ]);
    expect(saved.status).toBe(201);
  });

  it("review summasini serverda hisoblaydi, ikkinchi va parallel saqlashni 409 qiladi", async () => {
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01SAVE01",
    });
    const sessionId = await createSession({
      plate: "01SAVE01",
      enteredAt: new Date("2026-10-30T02:30:00.000Z"),
    });

    const first = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, session_id: sessionId, amount_som: 1 });
    const duplicate = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId, session_id: sessionId });

    expect(first.status).toBe(201);
    expect(first.body).toEqual(expect.objectContaining({
      candidate_id: candidate.candidateId,
      session_id: sessionId,
      duration_minutes: 150,
      amount_som: 18000,
      kind: "not_found",
      operator_id: operator.id,
      operator_name: "Smena Operatori",
      saved_by: owner.id,
    }));
    expect(duplicate.status).toBe(409);

    const parallelCandidate = await createCandidate({
      forcedAt: new Date("2026-10-30T06:00:00.000Z"),
      plate: "01PAR001",
    });
    const parallelSessionId = await createSession({
      plate: "01PAR001",
      enteredAt: new Date("2026-10-30T05:00:00.000Z"),
    });
    const parallel = await Promise.all([
      request(app)
        .post("/api/forced-open-audit/reviews")
        .set("Authorization", authorization(owner))
        .send({ candidate_id: parallelCandidate.candidateId, session_id: parallelSessionId }),
      request(app)
        .post("/api/forced-open-audit/reviews")
        .set("Authorization", authorization(owner))
        .send({ candidate_id: parallelCandidate.candidateId, session_id: parallelSessionId }),
    ]);
    const [{ count }] = await db("forced_open_reviews")
      .where({ org_id: orgId, candidate_id: parallelCandidate.candidateId })
      .count<{ count: string }[]>("id as count");
    const parallelReviewId = parallel.find((response) => response.status === 201)!.body.id;
    const logs = await db("tb_activity_logs")
      .where({ action: "forced_open_review.saved", target_type: "forced_open_review" })
      .whereIn("target_id", [first.body.id, parallelReviewId]);

    expect(parallel.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(Number(count)).toBe(1);
    expect(logs).toHaveLength(2);
  });

  it("session_found reviewda session_id ni o'zi oladi va reviewlar jamini qaytaradi", async () => {
    const sessionId = await createSession({
      plate: "01FOUND1",
      enteredAt: new Date("2026-10-30T02:00:00.000Z"),
      status: "completed",
      exitedAt: new Date("2026-10-30T04:00:00.000Z"),
      amount: 0,
      exitMethod: "forced",
    });
    const candidate = await createCandidate({
      forcedAt: new Date("2026-10-30T04:00:00.000Z"),
      plate: "01FOUND1",
      sessionId,
    });

    const saved = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: candidate.candidateId });
    const totals = await request(app)
      .get(`/api/forced-open-audit/reviews?operator_id=${operator.id}&date=2026-10-30`)
      .set("Authorization", authorization(owner));

    expect(saved.status).toBe(201);
    expect(saved.body).toEqual(expect.objectContaining({ session_id: sessionId, kind: "session_found" }));
    expect(totals.status).toBe(200);
    expect(totals.body).toEqual({
      operator_id: operator.id,
      from: "2026-10-30T03:00:00.000Z",
      to: "2026-10-31T03:00:00.000Z",
      items: [expect.objectContaining({
        review_id: saved.body.id,
        forced_at: "2026-10-30T04:00:00.000Z",
        detected_plate: "01FOUND1",
        session_plate: "01FOUND1",
        entered_at: "2026-10-30T02:00:00.000Z",
        duration_minutes: 120,
        amount_som: 12000,
        kind: "session_found",
        has_image: false,
        image_url: null,
      })],
      total: { count: 1, amount_som: 12000 },
    });
  });

  it("boshqa tashkilot nomzodini yashiradi va ownerdan boshqa rollarni 403 qiladi", async () => {
    const foreignOperator = await createTestUser(otherOrgId, { role: "operator" });
    const foreignCandidate = await createCandidate({
      orgId: otherOrgId,
      operatorId: foreignOperator.id,
      forcedAt: new Date("2026-10-30T05:00:00.000Z"),
      plate: "01FOREIGN",
    });

    const foreign = await request(app)
      .post("/api/forced-open-audit/reviews")
      .set("Authorization", authorization(owner))
      .send({ candidate_id: foreignCandidate.candidateId, session_id: 1 });

    expect(foreign.status).toBe(404);
    for (const actor of [operator, kassir, superAdmin]) {
      const denied = await request(app)
        .get(`/api/forced-open-audit?operator_id=${operator.id}&date=2026-10-30`)
        .set("Authorization", authorization(actor));
      expect(denied.status).toBe(403);
    }
  });
});
