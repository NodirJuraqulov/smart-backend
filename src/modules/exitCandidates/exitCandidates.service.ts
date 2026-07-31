import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { resolveExitCandidateSession } from "@/modules/parking/parking.service";
import { INSIDE_SESSION_STATUSES } from "@/modules/parking/sessionStatus";
import { resolveSafeCameraEventTime } from "@/modules/webhook/webhookIdempotency";
import { ApiError } from "@/utils/ApiError";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import {
  emitExitAwaitingPayment,
  emitExitCandidateCreated,
  emitExitCandidateResolved,
  emitExitCompleted,
  emitRelayFailed,
} from "@/websocket/socketServer";

type CandidateStatus = "pending" | "accepted" | "dismissed" | "expired";
type ResolutionType = "exact" | "reassigned" | "dismissed";

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
  plate_number: string;
  entered_at: Date;
  exited_at: Date | null;
  status: "active" | "awaiting_payment" | "completed";
  session_source: "regular" | "subscription" | "vip";
  amount: string | null;
  duration_minutes: number | null;
}

const PENDING_COALESCE_SECONDS = 30;

function imageUrl(eventId: number, kind: "overview" | "vehicle" | "plate", path: string | null | undefined) {
  return path ? `${env.publicBaseUrl}/api/webhook-events/${eventId}/images/${kind}` : null;
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
    overviewImageUrl: imageUrl(candidate.webhook_event_id, "overview", overviewPath),
    vehicleImageUrl: imageUrl(candidate.webhook_event_id, "vehicle", vehiclePath),
    plateImageUrl: imageUrl(candidate.webhook_event_id, "plate", platePath),
    matched_session: session,
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

async function loadSessionSummaries(ids: number[]): Promise<Map<number, SessionSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await db<SessionSummary>("tb_parking_sessions")
    .select(
      "id",
      "org_id",
      "plate_number",
      "entered_at",
      "exited_at",
      "status",
      "session_source",
      "amount",
      "duration_minutes"
    )
    .whereIn("id", ids);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function createExitCandidate(input: {
  orgId: number;
  webhookEventId: number;
  detectedPlate: string | null;
  confidence: number | null;
}) {
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

    const matchingSession = input.detectedPlate
      ? await trx<SessionSummary>("tb_parking_sessions")
          .select("id", "status")
          .where({ org_id: input.orgId, plate_number: input.detectedPlate })
          .whereIn("status", [...INSIDE_SESSION_STATUSES])
          .orderByRaw("CASE WHEN status = 'active' THEN 0 ELSE 1 END")
          .orderBy("entered_at", "desc")
          .first()
      : null;

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

    let pendingQuery = trx<CandidateRow>("tb_exit_candidates")
      .where({ org_id: input.orgId, status: "pending" })
      .andWhere("created_at", ">=", trx.raw(`NOW() - INTERVAL ${PENDING_COALESCE_SECONDS} SECOND`));
    if (matchedSession || input.detectedPlate) {
      pendingQuery = pendingQuery.andWhere((builder) => {
        if (matchedSession) builder.where("matched_session_id", matchedSession.id);
        if (input.detectedPlate) {
          if (matchedSession) builder.orWhere("detected_plate", input.detectedPlate);
          else builder.where("detected_plate", input.detectedPlate);
        }
      });
      const pending = await pendingQuery.orderBy("created_at", "desc").first();
      if (pending) {
        await trx("tb_webhook_events").where({ id: input.webhookEventId }).update({
          processing_result: "exit_candidate_coalesced",
          processing_reason: "pending_candidate_exists",
          session_id: matchedSession?.id ?? null,
        });
        return { candidateId: pending.id, created: false, coalesced: true, skipped: false as const };
      }
    }

    const safeCameraEventAt = resolveSafeCameraEventTime(
      webhookEvent.camera_event_at,
      webhookEvent.created_at
    );
    const [candidateId] = await trx("tb_exit_candidates").insert({
      org_id: input.orgId,
      webhook_event_id: input.webhookEventId,
      detected_plate: input.detectedPlate,
      matched_session_id: matchedSession?.id ?? null,
      confidence: input.confidence,
      camera_event_at: safeCameraEventAt,
    });
    await trx("tb_webhook_events").where({ id: input.webhookEventId }).update({
      processing_result: "exit_candidate_pending",
      processing_reason: matchedSession
        ? "exact_inside_session_found"
        : input.detectedPlate
          ? "inside_session_not_found"
          : "camera_ocr_failed",
      session_id: matchedSession?.id ?? null,
    });
    return { candidateId, created: true, coalesced: false, skipped: false as const };
  });

  if (result.skipped) return result;
  const candidate = await getCandidateByInternalId(input.orgId, result.candidateId);
  if (result.created) emitExitCandidateCreated(input.orgId, candidate);
  return { ...result, candidate };
}

async function getCandidateByInternalId(orgId: number, id: number) {
  const candidate = await candidateWithImagesQuery().where({
    "tb_exit_candidates.id": id,
    "tb_exit_candidates.org_id": orgId,
  }).first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  const sessions = await loadSessionSummaries(candidate.matched_session_id ? [candidate.matched_session_id] : []);
  return serializeCandidate(candidate, candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null);
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
  const sessionIds = candidates.flatMap((candidate) => candidate.matched_session_id ? [candidate.matched_session_id] : []);
  const sessions = await loadSessionSummaries(sessionIds);
  return {
    candidates: candidates.map((candidate) =>
      serializeCandidate(candidate, candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null)
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
  const suggestions = await db<SessionSummary>("tb_parking_sessions")
    .select(
      "id",
      "org_id",
      "plate_number",
      "entered_at",
      "exited_at",
      "status",
      "session_source",
      "amount",
      "duration_minutes"
    )
    .where({ org_id: orgId, status: "active" })
    .orderBy("entered_at", "desc")
    .limit(100);
  return { candidate, suggestions };
}

async function resolveAcceptedCandidate(input: {
  actor: AuthTokenPayload;
  requestedOrgId: number | undefined;
  candidateId: number;
  selectedSessionId?: number;
}) {
  const orgId = resolveOrgIdRequired(input.actor, input.requestedOrgId);
  const result = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: input.candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Chiqish nomzodi allaqachon hal qilingan", 409);

    const selectedSessionId = input.selectedSessionId ?? candidate.matched_session_id;
    if (!selectedSessionId) throw new ApiError("Tasdiqlash uchun faol sessiya tanlanishi kerak", 400);

    const resolvedElsewhere = await trx("tb_exit_candidates")
      .where({ org_id: orgId, resolved_session_id: selectedSessionId, status: "accepted" })
      .whereNot({ id: candidate.id })
      .first();
    if (resolvedElsewhere) throw new ApiError("Tanlangan sessiya boshqa nomzod orqali hal qilingan", 409);

    const resolution = await resolveExitCandidateSession(trx, {
      orgId,
      sessionId: selectedSessionId,
      cameraEventAt: new Date(candidate.camera_event_at),
    });
    const resolutionType: ResolutionType =
      selectedSessionId === candidate.matched_session_id ? "exact" : "reassigned";
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidate.id }).update({
      status: "accepted",
      resolution_type: resolutionType,
      resolved_session_id: selectedSessionId,
      resolved_by: input.actor.id,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: resolution.status === "completed" ? "exit_completed" : "exit_awaiting_payment",
      processing_reason: `candidate_${resolutionType}_accepted`,
      session_id: selectedSessionId,
      processed_at: trx.fn.now(),
    });
    await trx("tb_activity_logs").insert({
      actor_id: input.actor.id,
      action: resolutionType === "exact" ? "exit_candidate.accepted" : "exit_candidate.reassigned",
      target_type: "exit_candidate",
      target_id: candidate.id,
      details: JSON.stringify({
        orgId,
        detectedPlate: candidate.detected_plate,
        selectedSessionId,
        oldStatus: "active",
        newStatus: resolution.status,
        operatorId: input.actor.id,
      }),
    });
    return { candidate, resolution, resolutionType, selectedSessionId };
  });

  if (result.resolution.status === "completed") {
    const barrier = await openBarrier(orgId, "exit");
    if (barrier.status === "failed") {
      emitRelayFailed(orgId, {
        direction: "exit",
        plateNumber: result.resolution.session.plate_number,
        message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
      });
    }
    emitExitCompleted(orgId, { plateNumber: result.resolution.session.plate_number, amount: 0 });
  } else {
    emitExitAwaitingPayment(orgId, {
      plateNumber: result.resolution.session.plate_number,
      amount: Number(result.resolution.session.amount),
      enteredAt: result.resolution.session.entered_at,
      durationMinutes: result.resolution.session.duration_minutes,
    });
  }
  emitExitCandidateResolved(orgId, {
    candidateId: input.candidateId,
    status: "accepted",
    resolutionType: result.resolutionType,
    sessionId: result.selectedSessionId,
  });
  return getCandidateByInternalId(orgId, input.candidateId);
}

export function acceptExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number
) {
  return resolveAcceptedCandidate({ actor, requestedOrgId, candidateId });
}

export function reassignExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  sessionId: number
) {
  return resolveAcceptedCandidate({ actor, requestedOrgId, candidateId, selectedSessionId: sessionId });
}

export async function dismissExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  note?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Chiqish nomzodi allaqachon hal qilingan", 409);
    const matchedSession = candidate.matched_session_id
      ? await trx("tb_parking_sessions")
          .select("id", "status")
          .where({ id: candidate.matched_session_id, org_id: orgId })
          .first()
      : null;
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidateId }).update({
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
  });
  emitExitCandidateResolved(orgId, {
    candidateId,
    status: "dismissed",
    resolutionType: "dismissed",
    sessionId: null,
  });
  return getCandidateByInternalId(orgId, candidateId);
}
