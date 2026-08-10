import { promises as fs } from "fs";
import type { Knex } from "knex";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  calculateDurationMinutes,
  calculateTariffSnapshotAmount,
  displayPlateNumber,
  getSessionImage,
  TariffIntervalSnapshot,
} from "@/modules/parking/parking.service";
import { INSIDE_SESSION_STATUSES } from "@/modules/parking/sessionStatus";
import { BarrierStatus, openBarrier } from "@/modules/relay/relay.service";
import { getWebhookEventImage } from "@/modules/webhook/webhookEventImage.service";
import {
  editDistanceAtMostOne,
  resolveSafeCameraEventTime,
} from "@/modules/webhook/webhookIdempotency";
import {
  normalizeDetectedPlate,
  NULL_PLATE_COALESCE_WINDOW_MS,
  RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS,
} from "@/modules/webhook/webhookRules";
import { getExitDisplayStatus } from "@/modules/publicDisplay/publicDisplay.service";
import {
  findActiveInpatientVehicleForExit,
  findPendingClinicDiscountForExit,
  getOrgTodayDate,
  getOrgTodayRange,
  markClinicDiscountUsed,
} from "@/modules/medplus/medplus.service";
import { ApiError } from "@/utils/ApiError";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import {
  emitExitCandidateCreated,
  emitExitCandidateResolved,
  emitExitCompleted,
  emitPublicExitStatusChanged,
  emitRelayFailed,
} from "@/websocket/socketServer";

type CandidateStatus = "pending" | "accepted" | "dismissed" | "expired";
type ResolutionType = "exact" | "reassigned" | "dismissed" | "forced_open";
type PaymentMethod = "cash" | "online";
export type ForceOpenReason =
  | "plate_not_found"
  | "camera_misread"
  | "no_session"
  | "technical_issue"
  | "emergency"
  | "other";

interface CandidateRow {
  id: number;
  org_id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  matched_session_id: number | null;
  resolved_session_id: number | null;
  confidence: string | number | null;
  camera_event_at: Date;
  status: CandidateStatus;
  resolution_type: ResolutionType | null;
  resolved_by: number | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
  overview_image_path?: string | null;
  vehicle_image_path?: string | null;
  plate_image_path?: string | null;
}

interface SessionSummary {
  id: number;
  org_id: number;
  plate_number: string | null;
  entered_at: Date;
  exited_at: Date | null;
  status: "active" | "awaiting_payment" | "completed";
  session_source: "regular" | "subscription" | "vip";
  amount: string | number | null;
  duration_minutes: number | null;
  payment_method: PaymentMethod;
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: TariffIntervalSnapshot[] | string | null;
  entry_overview_image_path: string | null;
  entry_vehicle_image_path: string | null;
}

interface BarrierAuditDetails {
  orgId: number;
  candidateId: number;
  barrierStatus: BarrierStatus;
  retryAttempt: boolean;
  detail: string;
}

function serializeSessionSummary(session: SessionSummary) {
  const {
    tariff_price_per_hour: _tariffPrice,
    tariff_grace_period_minutes: _tariffGrace,
    tariff_intervals_snapshot: _tariffIntervals,
    entry_overview_image_path: _entryOverviewPath,
    entry_vehicle_image_path: _entryVehiclePath,
    ...publicSession
  } = session;
  return {
    ...publicSession,
    plate_number: displayPlateNumber(session.plate_number),
  };
}

const FORCE_OPEN_REASONS = new Set<ForceOpenReason>([
  "plate_not_found",
  "camera_misread",
  "no_session",
  "technical_issue",
  "emergency",
  "other",
]);
const BARRIER_AUDIT_ACTIONS = [
  "parking.exit_candidate_barrier_opened",
  "parking.exit_candidate_barrier_open_failed",
  "parking.exit_candidate_barrier_unavailable",
];

function eventImageUrl(eventId: number, kind: "overview" | "vehicle" | "plate", imagePath?: string | null) {
  return imagePath ? `${env.publicBaseUrl}/api/webhook-events/${eventId}/images/${kind}` : null;
}

function sessionImageUrl(sessionId: number, kind: "entry-overview" | "entry-vehicle", imagePath?: string | null) {
  return imagePath ? `${env.publicBaseUrl}/api/parking/sessions/${sessionId}/images/${kind}` : null;
}

function serializeCandidate(candidate: CandidateRow, session: SessionSummary | null = null) {
  const {
    overview_image_path: overviewPath,
    vehicle_image_path: vehiclePath,
    plate_image_path: platePath,
    ...publicCandidate
  } = candidate;
  return {
    ...publicCandidate,
    confidence: candidate.confidence === null ? null : Number(candidate.confidence),
    overviewImageUrl: eventImageUrl(candidate.webhook_event_id, "overview", overviewPath),
    vehicleImageUrl: eventImageUrl(candidate.webhook_event_id, "vehicle", vehiclePath),
    plateImageUrl: eventImageUrl(candidate.webhook_event_id, "plate", platePath),
    matched_session: session ? serializeSessionSummary(session) : null,
  };
}

function candidateWithImagesQuery(executor = db) {
  return executor<CandidateRow>("tb_exit_candidates")
    .leftJoin("tb_webhook_events", "tb_webhook_events.id", "tb_exit_candidates.webhook_event_id")
    .select(
      "tb_exit_candidates.*",
      "tb_webhook_events.overview_image_path",
      "tb_webhook_events.vehicle_image_path",
      "tb_webhook_events.plate_image_path"
    );
}

function sessionSummaryQuery(executor = db) {
  return executor<SessionSummary>("tb_parking_sessions").select(
    "id",
    "org_id",
    "plate_number",
    "entered_at",
    "exited_at",
    "status",
    "session_source",
    "amount",
    "duration_minutes",
    "payment_method",
    "tariff_price_per_hour",
    "tariff_grace_period_minutes",
    "tariff_intervals_snapshot",
    "entry_overview_image_path",
    "entry_vehicle_image_path"
  );
}

async function loadSessionSummaries(ids: number[], orgId?: number): Promise<Map<number, SessionSummary>> {
  if (ids.length === 0) return new Map();
  const query = sessionSummaryQuery().whereIn("id", ids);
  if (orgId !== undefined) query.andWhere({ org_id: orgId });
  const rows = await query;
  return new Map(rows.map((row) => [row.id, row]));
}

async function getCandidateByInternalId(orgId: number, id: number) {
  const candidate = await candidateWithImagesQuery()
    .where({ "tb_exit_candidates.id": id, "tb_exit_candidates.org_id": orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  const sessions = await loadSessionSummaries(
    candidate.matched_session_id ? [candidate.matched_session_id] : [],
    orgId
  );
  return serializeCandidate(
    candidate,
    candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null
  );
}

async function accessibleEventImageUrl(
  actor: AuthTokenPayload,
  eventId: number,
  kind: "overview" | "vehicle",
  imagePath: string | null | undefined
): Promise<string | null> {
  if (!imagePath) return null;
  try {
    await getWebhookEventImage(actor, eventId, kind);
    return eventImageUrl(eventId, kind, imagePath);
  } catch {
    return null;
  }
}

async function accessibleSessionImageUrl(
  actor: AuthTokenPayload,
  sessionId: number,
  kind: "entry-overview" | "entry-vehicle",
  imagePath: string | null | undefined
): Promise<string | null> {
  if (!imagePath) return null;
  try {
    const absolutePath = await getSessionImage(actor, sessionId, kind);
    await fs.access(absolutePath);
    return sessionImageUrl(sessionId, kind, imagePath);
  } catch {
    return null;
  }
}

async function exitImages(actor: AuthTokenPayload, candidate: CandidateRow) {
  const overviewUrl = await accessibleEventImageUrl(
    actor,
    candidate.webhook_event_id,
    "overview",
    candidate.overview_image_path
  );
  const vehicleUrl = overviewUrl
    ? null
    : await accessibleEventImageUrl(
        actor,
        candidate.webhook_event_id,
        "vehicle",
        candidate.vehicle_image_path
      );
  return { overview_url: overviewUrl, vehicle_url: vehicleUrl, image_available: !!(overviewUrl || vehicleUrl) };
}

async function entryImages(actor: AuthTokenPayload, session: SessionSummary) {
  const overviewUrl = await accessibleSessionImageUrl(
    actor,
    session.id,
    "entry-overview",
    session.entry_overview_image_path
  );
  const vehicleUrl = overviewUrl
    ? null
    : await accessibleSessionImageUrl(
        actor,
        session.id,
        "entry-vehicle",
        session.entry_vehicle_image_path
      );
  return { overview_url: overviewUrl, vehicle_url: vehicleUrl, image_available: !!(overviewUrl || vehicleUrl) };
}

function normalizePlate(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const MIN_FUZZY_PLATE_LENGTH = 6;

function isFuzzyPlateMatch(detectedPlate: string, candidatePlate: string | null): boolean {
  if (!candidatePlate) return false;
  if (
    detectedPlate.length < MIN_FUZZY_PLATE_LENGTH ||
    candidatePlate.length < MIN_FUZZY_PLATE_LENGTH
  ) {
    return false;
  }
  return editDistanceAtMostOne(detectedPlate, candidatePlate);
}

async function findFuzzyActiveSession(trx: Knex.Transaction, orgId: number, detectedPlate: string) {
  const sessions = await trx<SessionSummary>("tb_parking_sessions")
    .select("id", "status", "plate_number")
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number");
  const matches = sessions.filter((session) => isFuzzyPlateMatch(detectedPlate, session.plate_number));
  return matches.length === 1 ? matches[0] : undefined;
}

async function findFuzzyResolvedCandidate(
  trx: Knex.Transaction,
  orgId: number,
  detectedPlate: string,
  cooldownStart: Date
) {
  const candidates = await trx<CandidateRow>("tb_exit_candidates")
    .select("id", "detected_plate", "resolved_session_id")
    .where({ org_id: orgId })
    .whereIn("status", ["accepted", "dismissed"])
    .whereNotNull("resolved_at")
    .andWhere("resolved_at", ">=", cooldownStart)
    .orderBy("resolved_at", "desc");
  const matches = candidates.filter((candidate) =>
    isFuzzyPlateMatch(detectedPlate, candidate.detected_plate)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

async function findFuzzyPendingCandidate(
  trx: Knex.Transaction,
  orgId: number,
  detectedPlate: string
) {
  const candidates = await trx<CandidateRow>("tb_exit_candidates")
    .where({ org_id: orgId, status: "pending" })
    .whereNotNull("detected_plate")
    .orderBy("camera_event_at", "desc")
    .forUpdate();
  const matches = candidates.filter((candidate) =>
    isFuzzyPlateMatch(detectedPlate, candidate.detected_plate)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function canonicalPlate(value: string): string {
  const mapping: Record<string, string> = { O: "0", I: "1", B: "8", S: "5", Z: "2", G: "6" };
  return [...value].map((char) => mapping[char] ?? char).join("");
}

function damerauLevenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[left.length][right.length];
}

function similarityScore(input: string, candidate: string): number | null {
  const normalizedInput = normalizePlate(input);
  const normalizedCandidate = normalizePlate(candidate);
  if (!normalizedInput || !normalizedCandidate) return null;
  if (normalizedInput === normalizedCandidate) return 100;
  const canonicalInput = canonicalPlate(normalizedInput);
  const canonicalCandidate = canonicalPlate(normalizedCandidate);
  if (canonicalInput === canonicalCandidate) return 98;
  const distance = Math.min(
    damerauLevenshtein(normalizedInput, normalizedCandidate),
    damerauLevenshtein(canonicalInput, canonicalCandidate)
  );
  if (distance > 2) return null;
  const length = Math.max(normalizedInput.length, normalizedCandidate.length, 1);
  return Math.round((1 - distance / length) * 10000) / 100;
}

function parseActivityDetails(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function recordBarrierAttempt(input: {
  actorId: number;
  orgId: number;
  candidateId: number;
  retryAttempt: boolean;
}): Promise<BarrierStatus> {
  let status: BarrierStatus;
  let detail: string;
  try {
    const result = await openBarrier(input.orgId, "exit");
    status = result.status;
    detail = result.detail ?? result.status;
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
  }
  const action =
    status === "opened"
      ? "parking.exit_candidate_barrier_opened"
      : status === "failed"
        ? "parking.exit_candidate_barrier_open_failed"
        : "parking.exit_candidate_barrier_unavailable";
  const details: BarrierAuditDetails = {
    orgId: input.orgId,
    candidateId: input.candidateId,
    barrierStatus: status,
    retryAttempt: input.retryAttempt,
    detail,
  };
  await db("tb_activity_logs").insert({
    actor_id: input.actorId,
    action,
    target_type: "exit_candidate",
    target_id: input.candidateId,
    details: JSON.stringify(details),
  });
  return status;
}

export async function createExitCandidate(input: {
  orgId: number;
  webhookEventId: number;
  detectedPlate: string | null;
  confidence: number | null;
}) {
  const detectedPlate = normalizeDetectedPlate(input.detectedPlate);
  const result = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();
    const existingByEvent = await trx<CandidateRow>("tb_exit_candidates")
      .where({ webhook_event_id: input.webhookEventId, org_id: input.orgId })
      .first();
    if (existingByEvent) {
      return { candidateId: existingByEvent.id, created: false, coalesced: false, skipped: false as const };
    }
    const webhookEvent = await trx("tb_webhook_events")
      .select("camera_event_at", "created_at")
      .where({ id: input.webhookEventId, org_id: input.orgId, direction: "exit" })
      .first();
    if (!webhookEvent) throw new ApiError("Webhook exit hodisasi topilmadi", 404);
    const cameraEventAt = resolveSafeCameraEventTime(webhookEvent.camera_event_at, webhookEvent.created_at);
    let matchingSession = detectedPlate
      ? await trx<SessionSummary>("tb_parking_sessions")
          .select("id", "status")
          .where({ org_id: input.orgId, plate_number: detectedPlate })
          .whereIn("status", [...INSIDE_SESSION_STATUSES])
          .orderByRaw("CASE WHEN status = 'active' THEN 0 ELSE 1 END")
          .orderBy("entered_at", "desc")
          .first()
      : undefined;
    if (detectedPlate && !matchingSession) {
      matchingSession = await findFuzzyActiveSession(trx, input.orgId, detectedPlate);
    }
    if (matchingSession?.status === "awaiting_payment") {
      await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
        processing_result: "already_awaiting_payment",
        processing_reason: "session_already_awaiting_payment",
        session_id: matchingSession.id,
      });
      return {
        skipped: true as const,
        reason: "already_awaiting_payment" as const,
        sessionId: matchingSession.id,
      };
    }
    const matchedSession = matchingSession?.status === "active" ? matchingSession : null;
    if (detectedPlate && !matchedSession) {
      const cooldownStart = new Date(Date.now() - RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS);
      let resolvedCandidate = await trx<CandidateRow>("tb_exit_candidates")
        .select("id", "resolved_session_id")
        .where({ org_id: input.orgId, detected_plate: detectedPlate })
        .whereIn("status", ["accepted", "dismissed"])
        .whereNotNull("resolved_at")
        .andWhere("resolved_at", ">=", cooldownStart)
        .orderBy("resolved_at", "desc")
        .first();
      if (!resolvedCandidate) {
        resolvedCandidate = await findFuzzyResolvedCandidate(
          trx,
          input.orgId,
          detectedPlate,
          cooldownStart
        );
      }
      if (resolvedCandidate) {
        await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
          processing_result: "resolved_recently_ignored",
          processing_reason: "resolved_candidate_cooldown",
          session_id: resolvedCandidate.resolved_session_id,
          processed_at: trx.fn.now(),
        });
        return {
          skipped: true as const,
          reason: "resolved_recently_ignored" as const,
          sessionId: resolvedCandidate.resolved_session_id ?? undefined,
        };
      }
    }
    let pendingQuery = trx<CandidateRow>("tb_exit_candidates").where({
      org_id: input.orgId,
      status: "pending",
    });
    if (detectedPlate) {
      pendingQuery = pendingQuery.andWhere({ detected_plate: detectedPlate });
    } else {
      pendingQuery = pendingQuery
        .whereNull("detected_plate")
        .andWhere(
          "camera_event_at",
          ">=",
          new Date(cameraEventAt.getTime() - NULL_PLATE_COALESCE_WINDOW_MS)
        )
        .andWhere(
          "camera_event_at",
          "<=",
          new Date(cameraEventAt.getTime() + NULL_PLATE_COALESCE_WINDOW_MS)
        );
    }
    let pending = await pendingQuery.orderBy("camera_event_at", "desc").forUpdate().first();
    if (!pending && detectedPlate) {
      pending = await findFuzzyPendingCandidate(trx, input.orgId, detectedPlate);
    }
    if (pending) {
      await trx("tb_exit_candidates").where({ id: pending.id, org_id: input.orgId }).update({
        camera_event_at: cameraEventAt,
        confidence: input.confidence,
        updated_at: trx.fn.now(),
      });
      await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
        processing_result: "exit_candidate_coalesced",
        processing_reason: "pending_candidate_exists",
        session_id: matchedSession?.id ?? pending.matched_session_id ?? null,
      });
      return { candidateId: pending.id, created: false, coalesced: true, skipped: false as const };
    }
    const [candidateId] = await trx("tb_exit_candidates").insert({
      org_id: input.orgId,
      webhook_event_id: input.webhookEventId,
      detected_plate: detectedPlate,
      matched_session_id: matchedSession?.id ?? null,
      confidence: input.confidence,
      camera_event_at: cameraEventAt,
    });
    await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
      processing_result: "exit_candidate_pending",
      processing_reason: matchedSession
        ? "exact_inside_session_found"
        : detectedPlate
          ? "inside_session_not_found"
          : "camera_ocr_failed",
      session_id: matchedSession?.id ?? null,
    });
    await trx("tb_activity_logs").insert({
      actor_id: null,
      action: "parking.exit_candidate_created",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        orgId: input.orgId,
        candidateId,
        detectedPlate,
        matchedSessionId: matchedSession?.id ?? null,
        webhookEventId: input.webhookEventId,
        confidence: input.confidence,
      }),
    });
    return { candidateId, created: true, coalesced: false, skipped: false as const };
  });
  if (result.skipped) return result;
  const candidate = await getCandidateByInternalId(input.orgId, result.candidateId);
  if (result.created) {
    emitExitCandidateCreated(input.orgId, {
      candidateId: candidate.id,
      orgId: input.orgId,
      webhookEventId: candidate.webhook_event_id,
      detectedPlate: candidate.detected_plate,
      matchedSessionId: candidate.matched_session_id,
      confidence: candidate.confidence,
      cameraEventAt: new Date(candidate.camera_event_at).toISOString(),
      status: "pending",
      exitImages: {
        overviewUrl: candidate.overviewImageUrl,
        vehicleUrl: candidate.vehicleImageUrl,
        plateUrl: candidate.plateImageUrl,
      },
    });
  }
  return { ...result, candidate };
}

export async function listExitCandidates(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const [{ count }] = await db("tb_exit_candidates")
    .where({ org_id: orgId, status: "pending" })
    .count<{ count: string }[]>("id as count");
  const candidates = await candidateWithImagesQuery()
    .where({ "tb_exit_candidates.org_id": orgId, "tb_exit_candidates.status": "pending" })
    .orderBy("tb_exit_candidates.created_at", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  const sessionIds = candidates.flatMap((candidate) =>
    candidate.matched_session_id ? [candidate.matched_session_id] : []
  );
  const sessions = await loadSessionSummaries(sessionIds, orgId);
  return {
    candidates: candidates.map((candidate) =>
      serializeCandidate(
        candidate,
        candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null
      )
    ),
    pagination: {
      page: input.page,
      limit: input.limit,
      total: Number(count),
      total_pages: Math.ceil(Number(count) / input.limit) || 1,
    },
  };
}

export async function getExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  id: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const candidate = await getCandidateByInternalId(orgId, id);
  const suggestions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .orderBy("entered_at", "desc")
    .limit(100);
  return { candidate, suggestions: suggestions.map(serializeSessionSummary) };
}

export async function getNextExitCandidate(actor: AuthTokenPayload, requestedOrgId: number | undefined) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const [{ count }] = await db("tb_exit_candidates")
    .where({ org_id: orgId, status: "pending" })
    .count<{ count: string }[]>("id as count");
  const candidate = await candidateWithImagesQuery()
    .where({ "tb_exit_candidates.org_id": orgId, "tb_exit_candidates.status": "pending" })
    .orderBy("tb_exit_candidates.created_at", "asc")
    .orderBy("tb_exit_candidates.id", "asc")
    .first();
  if (!candidate) return { candidate: null, pending_count_for_org: 0 };
  const session = candidate.detected_plate
    ? await sessionSummaryQuery()
        .where({ org_id: orgId, status: "active", plate_number: candidate.detected_plate })
        .orderBy("entered_at", "desc")
        .first()
    : null;
  const now = new Date();
  const matchedSession = session
    ? {
        session_id: session.id,
        plate_number: session.plate_number,
        session_source: session.session_source,
        entered_at: session.entered_at,
        entry_images: await entryImages(actor, session),
        duration_minutes: calculateDurationMinutes(new Date(session.entered_at), now),
        tariff_snapshot_amount: calculateTariffSnapshotAmount(
          session,
          calculateDurationMinutes(new Date(session.entered_at), now)
        ),
      }
    : null;
  return {
    candidate_id: candidate.id,
    status: candidate.status,
    webhook_event_id: candidate.webhook_event_id,
    detected_plate: candidate.detected_plate,
    camera_event_at: candidate.camera_event_at,
    exit_images: await exitImages(actor, candidate),
    matched_session: matchedSession,
    pending_count_for_org: Number(count),
  };
}

export async function searchExitCandidateSessions(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  plate?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const candidate = await db<CandidateRow>("tb_exit_candidates")
    .where({ id: candidateId, org_id: orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
  const now = new Date();
  const activeSessions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .orderBy("entered_at", "asc")
    .limit(30);
  const active_sessions = await Promise.all(
    activeSessions.map(async (session) => {
      const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
      return {
        session_id: String(session.id),
        plate_number: displayPlateNumber(session.plate_number),
        entered_at: new Date(session.entered_at).toISOString(),
        session_source: session.session_source,
        duration_minutes: durationMinutes,
        tariff_snapshot_amount: calculateTariffSnapshotAmount(session, durationMinutes) ?? 0,
        entry_images: await entryImages(actor, session),
      };
    })
  );
  const normalized = plate ? normalizePlate(plate) : "";
  if (!normalized) return { results: [], active_sessions };
  const sessions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number");
  const scored = sessions
    .map((session) => ({
      session,
      score: session.plate_number === null ? null : similarityScore(normalized, session.plate_number),
    }))
    .filter((item): item is { session: SessionSummary; score: number } => item.score !== null)
    .sort((left, right) => right.score - left.score || left.session.id - right.session.id)
    .slice(0, 10);
  const results = await Promise.all(
    scored.map(async ({ session, score }) => {
      const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
      return {
        session_id: String(session.id),
        plate_number: displayPlateNumber(session.plate_number),
        entered_at: new Date(session.entered_at).toISOString(),
        session_source: session.session_source,
        similarity_score: score,
        duration_minutes: durationMinutes,
        tariff_snapshot_amount: calculateTariffSnapshotAmount(session, durationMinutes) ?? 0,
        entry_images: await entryImages(actor, session),
      };
    })
  );
  return { results, active_sessions };
}

export async function confirmExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  input: { sessionId?: number; paymentMethod?: PaymentMethod }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const transactionResult = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const organization = await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const selectedSessionId = input.sessionId ?? candidate.matched_session_id;
    if (!selectedSessionId) throw new ApiError("Sessiya tanlanmagan", 400);
    const session = await sessionSummaryQuery(trx)
      .where({ id: selectedSessionId, org_id: orgId })
      .forUpdate()
      .first();
    if (session?.status === "completed") {
      throw new ApiError("Bu mashina allaqachon chiqib ketgan", 409);
    }
    if (!session || session.status !== "active") {
      throw new ApiError("Tanlangan faol sessiya topilmadi", 409);
    }
    if (
      session.session_source === "regular" &&
      input.paymentMethod !== "cash" &&
      input.paymentMethod !== "online"
    ) {
      throw new ApiError("payment_method 'cash' yoki 'online' bo'lishi kerak", 400);
    }
    const exitedAt = new Date();
    const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), exitedAt);
    const snapshotAmount = calculateTariffSnapshotAmount(session, durationMinutes);
    if (session.session_source === "regular" && snapshotAmount === null) {
      throw new ApiError("Sessiyaning kirish vaqtidagi tarif snapshoti topilmadi", 409);
    }
    let amount = session.session_source === "regular" ? snapshotAmount! : 0;
    const paymentMethod = session.session_source === "regular" ? input.paymentMethod! : session.payment_method;

    let inpatientFreeExit = false;
    let appliedClinicDiscount: { id: number; discountPercent: number; originalAmount: number } | null = null;
    if (session.session_source === "regular" && session.plate_number) {
      const todayDate = getOrgTodayDate(organization?.timezone);
      const inpatientVehicle = await findActiveInpatientVehicleForExit(
        orgId,
        session.plate_number,
        todayDate,
        trx
      );
      if (inpatientVehicle) {
        inpatientFreeExit = true;
        amount = 0;
      } else {
        const todayRange = getOrgTodayRange(organization?.timezone);
        const discount = await findPendingClinicDiscountForExit(orgId, session.plate_number, todayRange, trx);
        if (discount) {
          const originalAmount = amount;
          amount = Math.round((amount * (100 - discount.discount_percent)) / 100 * 100) / 100;
          appliedClinicDiscount = {
            id: discount.id,
            discountPercent: discount.discount_percent,
            originalAmount,
          };
        }
      }
    }

    let payment: { id: number; amount: number; payment_method: PaymentMethod; paid_at: Date } | null = null;
    if (session.session_source === "regular" && !inpatientFreeExit) {
      const [paymentId] = await trx("tb_payments").insert({
        org_id: orgId,
        session_id: session.id,
        amount,
        payment_method: paymentMethod,
        paid_at: exitedAt,
        operator_id: actor.id,
      });
      payment = { id: paymentId, amount, payment_method: paymentMethod, paid_at: exitedAt };
    }
    await trx("tb_parking_sessions").where({ id: session.id, org_id: orgId }).update({
      status: "completed",
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount,
      payment_method: paymentMethod,
      exit_method: "auto",
      operator_id: actor.id,
      active_plate_key: null,
    });
    const resolutionType: ResolutionType = input.sessionId === undefined ? "exact" : "reassigned";
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidate.id, org_id: orgId }).update({
      status: "accepted",
      resolution_type: resolutionType,
      resolved_session_id: session.id,
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_completed",
      processing_reason: `candidate_${resolutionType}_confirmed`,
      session_id: session.id,
      processed_at: trx.fn.now(),
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: resolutionType === "exact" ? "exit_candidate.accepted" : "exit_candidate.reassigned",
      target_type: "exit_candidate",
      target_id: candidate.id,
      details: JSON.stringify({
        orgId,
        detectedPlate: candidate.detected_plate,
        selectedSessionId: session.id,
        oldStatus: "active",
        newStatus: "completed",
        operatorId: actor.id,
        amount,
        paymentMethod: session.session_source === "regular" ? paymentMethod : null,
      }),
    });
    if (inpatientFreeExit) {
      await trx("tb_activity_logs").insert({
        actor_id: actor.id,
        action: "inpatient_free_exit",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId,
          sessionId: session.id,
          plateNumber: session.plate_number,
        }),
      });
    }
    if (appliedClinicDiscount) {
      await markClinicDiscountUsed(appliedClinicDiscount.id, session.id, exitedAt, trx);
      await trx("tb_activity_logs").insert({
        actor_id: actor.id,
        action: "clinic_discount_applied",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId,
          sessionId: session.id,
          discountId: appliedClinicDiscount.id,
          discountPercent: appliedClinicDiscount.discountPercent,
          originalAmount: appliedClinicDiscount.originalAmount,
          discountedAmount: amount,
        }),
      });
    }
    return {
      session: {
        ...session,
        status: "completed" as const,
        exited_at: exitedAt,
        duration_minutes: durationMinutes,
        amount,
        payment_method: paymentMethod,
        active_plate_key: null,
      },
      payment,
      resolutionType,
    };
  });
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: false,
  });
  if (barrierStatus === "failed") {
    emitRelayFailed(orgId, {
      direction: "exit",
      plateNumber: displayPlateNumber(transactionResult.session.plate_number),
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }
  emitExitCompleted(orgId, {
    orgId,
    sessionId: transactionResult.session.id,
    plateNumber: displayPlateNumber(transactionResult.session.plate_number),
    amount: transactionResult.session.amount,
    paymentMethod:
      transactionResult.session.session_source === "regular"
        ? transactionResult.session.payment_method
        : null,
    barrierStatus,
    sessionSource: transactionResult.session.session_source,
    durationMinutes: transactionResult.session.duration_minutes,
  });
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "accepted",
    resolutionType: transactionResult.resolutionType,
    sessionId: transactionResult.session.id,
    barrierStatus,
    plateNumber: displayPlateNumber(transactionResult.session.plate_number),
    sessionSource: transactionResult.session.session_source,
    amount: transactionResult.session.amount,
    paymentMethod:
      transactionResult.session.session_source === "regular"
        ? transactionResult.session.payment_method
        : null,
    durationMinutes: transactionResult.session.duration_minutes,
  });
  return {
    candidate: await getCandidateByInternalId(orgId, candidateId),
    session: serializeSessionSummary(transactionResult.session),
    payment: transactionResult.payment,
    barrier_status: barrierStatus,
  };
}

export async function forceOpenExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  input: { reason?: ForceOpenReason; note?: string; enteredPlate?: string }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const reason = input.reason ?? "other";
  if (!FORCE_OPEN_REASONS.has(reason)) throw new ApiError("Majburiy ochish sababi noto'g'ri", 400);
  const note = input.note?.trim().slice(0, 500) || null;
  const enteredPlate = input.enteredPlate ? normalizePlate(input.enteredPlate) || null : null;
  await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const event = await trx("tb_webhook_events")
      .select("overview_image_path", "vehicle_image_path")
      .where({ id: candidate.webhook_event_id, org_id: orgId })
      .first();
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
      status: "dismissed",
      resolution_type: "forced_open",
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      resolution_note: note,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_candidate_forced_open",
      processing_reason: reason,
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "exit_candidate.forced_open",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        operatorId: actor.id,
        orgId,
        reason,
        note,
        enteredPlate,
        candidateId,
        webhookEventId: candidate.webhook_event_id,
        exitImageRef: event?.overview_image_path ?? event?.vehicle_image_path ?? null,
      }),
    });
  });
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: false,
  });
  const resolvedCandidate = await getCandidateByInternalId(orgId, candidateId);
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "dismissed",
    resolutionType: "forced_open",
    sessionId: null,
    barrierStatus,
    plateNumber: resolvedCandidate.detected_plate,
  });
  return { candidate: resolvedCandidate, barrier_status: barrierStatus };
}

export async function retryExitCandidateBarrier(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const candidate = await db<CandidateRow>("tb_exit_candidates")
    .where({ id: candidateId, org_id: orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  if (candidate.status !== "accepted" && candidate.status !== "dismissed") {
    throw new ApiError("Shlagbaumni qayta ochish uchun candidate hal qilingan bo'lishi kerak", 400);
  }
  const latestAttempt = await db("tb_activity_logs")
    .where({ target_type: "exit_candidate", target_id: candidateId })
    .whereIn("action", BARRIER_AUDIT_ACTIONS)
    .orderBy("id", "desc")
    .first();
  const details = parseActivityDetails(latestAttempt?.details);
  if (details.orgId === orgId && (details.barrierStatus === "disabled" || details.barrierStatus === "not_configured")) {
    throw new ApiError("Shlagbaum konfiguratsiya qilinmagan, administrator bilan bog'laning", 400);
  }
  if (!latestAttempt || details.orgId !== orgId || details.barrierStatus !== "failed") {
    throw new ApiError("Oxirgi shlagbaum ochish urinishi failed holatida emas", 400);
  }
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: true,
  });
  emitPublicExitStatusChanged(orgId, await getExitDisplayStatus(orgId));
  return { barrier_status: barrierStatus };
}

export function acceptExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  paymentMethod?: PaymentMethod
) {
  console.warn(`Deprecated exit candidate accept endpoint ishlatildi: candidate_id=${candidateId}`);
  return confirmExitCandidate(actor, requestedOrgId, candidateId, { paymentMethod });
}

export function reassignExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  sessionId: number,
  paymentMethod?: PaymentMethod
) {
  console.warn(`Deprecated exit candidate reassign endpoint ishlatildi: candidate_id=${candidateId}`);
  return confirmExitCandidate(actor, requestedOrgId, candidateId, { sessionId, paymentMethod });
}

export async function dismissExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  note?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const detectedPlate = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const matchedSession = candidate.matched_session_id
      ? await trx("tb_parking_sessions")
          .select("id", "status")
          .where({ id: candidate.matched_session_id, org_id: orgId })
          .first()
      : null;
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
      status: "dismissed",
      resolution_type: "dismissed",
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      resolution_note: note?.trim().slice(0, 500) || null,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_candidate_dismissed",
      processing_reason: "operator_dismissed",
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "exit_candidate.dismissed",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        orgId,
        detectedPlate: candidate.detected_plate,
        selectedSessionId: matchedSession?.id ?? null,
        oldStatus: matchedSession?.status ?? null,
        newStatus: matchedSession?.status ?? null,
        operatorId: actor.id,
      }),
    });
    return candidate.detected_plate;
  });
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "dismissed",
    resolutionType: "dismissed",
    sessionId: null,
    barrierStatus: null,
    plateNumber: detectedPlate,
  });
  return getCandidateByInternalId(orgId, candidateId);
}
