import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  attachWebhookEntryImages,
  createEntrySessionInTransaction,
  displayPlateNumber,
  hasAvailableCapacity,
  SessionRecord,
} from "@/modules/parking/parking.service";
import { BarrierStatus, openBarrier } from "@/modules/relay/relay.service";
import { NormalizedCameraEvent } from "@/modules/webhook/parsers/normalizedCameraEvent";
import { getWebhookEventImage } from "@/modules/webhook/webhookEventImage.service";
import { resolveSafeCameraEventTime } from "@/modules/webhook/webhookIdempotency";
import { ApiError } from "@/utils/ApiError";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import {
  emitEntryBarrierFailed,
  emitEntryCandidateCreated,
  emitEntryCandidateResolved,
  emitEntryCompleted,
  emitEntryDetected,
  emitParkingFull,
} from "@/websocket/socketServer";

type EntryCandidateStatus = "pending" | "accepted" | "declined" | "expired";
type EntryCandidateReason = "capacity_full" | "plate_not_detected" | "capacity_full_and_plate_not_detected";

interface EntryCandidateRow {
  id: number;
  org_id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  reason: EntryCandidateReason;
  confidence: string | number | null;
  camera_event_at: Date;
  status: EntryCandidateStatus;
  resolution_type: "accepted" | "declined" | null;
  resolved_session_id: number | null;
  resolved_by: number | null;
  resolved_at: Date | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
  overview_image_path?: string | null;
  vehicle_image_path?: string | null;
}

interface EntryBarrierAuditDetails {
  orgId: number;
  direction: "entry";
  sessionId: number;
  barrierStatus: BarrierStatus;
  detail: string;
  retryAttempt: boolean;
}

const ENTRY_BARRIER_AUDIT_ACTIONS = [
  "parking.entry_barrier_opened",
  "parking.entry_barrier_open_failed",
  "parking.entry_barrier_unavailable",
];

function normalizePlate(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "";
  return normalized || null;
}

function candidateQuery() {
  return db<EntryCandidateRow>("tb_entry_candidates")
    .leftJoin("tb_webhook_events", "tb_webhook_events.id", "tb_entry_candidates.webhook_event_id")
    .select(
      "tb_entry_candidates.*",
      "tb_webhook_events.overview_image_path",
      "tb_webhook_events.vehicle_image_path"
    );
}

function eventImageUrl(eventId: number, kind: "overview" | "vehicle", path: string | null | undefined) {
  return path ? `${env.publicBaseUrl}/api/webhook-events/${eventId}/images/${kind}` : null;
}

async function accessibleEventImageUrl(
  actor: AuthTokenPayload,
  candidate: EntryCandidateRow,
  kind: "overview" | "vehicle",
  path: string | null | undefined
) {
  if (!path) return null;
  try {
    await getWebhookEventImage(actor, candidate.webhook_event_id, kind);
    return eventImageUrl(candidate.webhook_event_id, kind, path);
  } catch {
    return null;
  }
}

async function entryImages(actor: AuthTokenPayload, candidate: EntryCandidateRow) {
  const overviewUrl = await accessibleEventImageUrl(actor, candidate, "overview", candidate.overview_image_path);
  const vehicleUrl = overviewUrl
    ? null
    : await accessibleEventImageUrl(actor, candidate, "vehicle", candidate.vehicle_image_path);
  return {
    overview_url: overviewUrl,
    vehicle_url: vehicleUrl,
    image_available: Boolean(overviewUrl || vehicleUrl),
  };
}

function websocketImages(candidate: EntryCandidateRow) {
  const overviewUrl = eventImageUrl(candidate.webhook_event_id, "overview", candidate.overview_image_path);
  const vehicleUrl = overviewUrl
    ? null
    : eventImageUrl(candidate.webhook_event_id, "vehicle", candidate.vehicle_image_path);
  return { overviewUrl, vehicleUrl, imageAvailable: Boolean(overviewUrl || vehicleUrl) };
}

async function findCandidate(orgId: number, candidateId: number): Promise<EntryCandidateRow> {
  const candidate = await candidateQuery()
    .where({ "tb_entry_candidates.id": candidateId, "tb_entry_candidates.org_id": orgId })
    .first();
  if (!candidate) throw new ApiError("Kirish nomzodi topilmadi", 404);
  return candidate;
}

async function recordEntryBarrierAttempt(input: {
  actorId: number | null;
  orgId: number;
  sessionId: number;
  retryAttempt: boolean;
}) {
  let status: BarrierStatus;
  let detail: string;
  try {
    const result = await openBarrier(input.orgId, "entry");
    status = result.status;
    detail = result.detail ?? result.status;
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
  }
  const action =
    status === "opened"
      ? "parking.entry_barrier_opened"
      : status === "failed"
        ? "parking.entry_barrier_open_failed"
        : "parking.entry_barrier_unavailable";
  const details: EntryBarrierAuditDetails = {
    orgId: input.orgId,
    direction: "entry",
    sessionId: input.sessionId,
    barrierStatus: status,
    detail,
    retryAttempt: input.retryAttempt,
  };
  await db("tb_activity_logs").insert({
    actor_id: input.actorId,
    action,
    target_type: "session",
    target_id: input.sessionId,
    details: JSON.stringify(details),
  });
  return { status, detail };
}

export async function processEntryWebhook(input: {
  orgId: number;
  webhookEventId: number;
  event: NormalizedCameraEvent;
}) {
  const transactionResult = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();
    const webhookEvent = await trx("tb_webhook_events")
      .select("camera_event_at", "created_at")
      .where({ id: input.webhookEventId, org_id: input.orgId, direction: "entry" })
      .first();
    if (!webhookEvent) throw new ApiError("Webhook kirish hodisasi topilmadi", 404);
    const cameraEventAt = resolveSafeCameraEventTime(webhookEvent.camera_event_at, webhookEvent.created_at);
    const plateNumber = input.event.plateNumber || null;
    const existingCandidate = await trx<EntryCandidateRow>("tb_entry_candidates")
      .where({ org_id: input.orgId, webhook_event_id: input.webhookEventId })
      .first();
    if (existingCandidate) {
      return {
        type: "candidate" as const,
        candidateId: existingCandidate.id,
        created: false,
        reason: existingCandidate.reason,
      };
    }
    let pendingQuery = trx<EntryCandidateRow>("tb_entry_candidates")
      .where({ org_id: input.orgId, status: "pending" });
    if (plateNumber) {
      pendingQuery = pendingQuery.andWhere({ detected_plate: plateNumber });
    } else {
      pendingQuery = pendingQuery
        .whereNull("detected_plate")
        .whereIn("reason", ["plate_not_detected", "capacity_full_and_plate_not_detected"])
        .andWhere("camera_event_at", ">=", new Date(cameraEventAt.getTime() - 60_000))
        .andWhere("camera_event_at", "<=", new Date(cameraEventAt.getTime() + 60_000));
    }
    const pendingCandidate = await pendingQuery.orderBy("camera_event_at", "desc").forUpdate().first();
    if (pendingCandidate) {
      await trx("tb_entry_candidates").where({ id: pendingCandidate.id }).update({
        camera_event_at: cameraEventAt,
        confidence: input.event.confidence,
        updated_at: trx.fn.now(),
      });
      await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
        processing_result: "entry_candidate_coalesced",
        processing_reason: "pending_candidate_exists",
      });
      return {
        type: "candidate" as const,
        candidateId: pendingCandidate.id,
        created: false,
        reason: pendingCandidate.reason,
      };
    }
    const capacityAvailable = await hasAvailableCapacity(input.orgId, trx);
    if (plateNumber && capacityAvailable) {
      try {
        const session = await createEntrySessionInTransaction(trx, {
          orgId: input.orgId,
          plateNumber,
          entryMethod: "auto",
          operatorId: null,
          enteredAt: new Date(),
        });
        await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
          processing_result: "entry_created",
          processing_reason: null,
          session_id: session.id,
          processed_at: trx.fn.now(),
        });
        await trx("tb_activity_logs").insert({
          actor_id: null,
          action: "parking.entry_webhook",
          target_type: "session",
          target_id: session.id,
          details: JSON.stringify({ plateNumber, orgId: input.orgId }),
        });
        return { type: "session" as const, session };
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 409) {
          await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
            processing_result: "active_entry_already_exists",
            processing_reason: "already_active",
          });
          return { type: "rejected" as const, reason: "already_active" as const };
        }
        if (err instanceof ApiError) {
          await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
            processing_result: "entry_rejected",
            processing_reason: "entry_policy_rejected",
          });
          return { type: "rejected" as const, reason: "rejected" as const };
        }
        throw err;
      }
    }
    const reason: EntryCandidateReason = plateNumber
      ? "capacity_full"
      : capacityAvailable
        ? "plate_not_detected"
        : "capacity_full_and_plate_not_detected";
    const [candidateId] = await trx("tb_entry_candidates").insert({
      org_id: input.orgId,
      webhook_event_id: input.webhookEventId,
      detected_plate: plateNumber,
      reason,
      confidence: input.event.confidence,
      camera_event_at: cameraEventAt,
    });
    await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
      processing_result: "entry_candidate_pending",
      processing_reason: reason,
    });
    await trx("tb_activity_logs").insert({
      actor_id: null,
      action: "parking.entry_candidate_created",
      target_type: "entry_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        orgId: input.orgId,
        candidateId,
        detectedPlate: plateNumber,
        reason,
        webhookEventId: input.webhookEventId,
        confidence: input.event.confidence,
      }),
    });
    return { type: "candidate" as const, candidateId, created: true, reason };
  });

  if (transactionResult.type === "rejected") {
    return { created: false as const, reason: transactionResult.reason };
  }
  if (transactionResult.type === "candidate") {
    const candidate = await findCandidate(input.orgId, transactionResult.candidateId);
    if (transactionResult.created) {
      if (transactionResult.reason !== "plate_not_detected") {
        emitParkingFull(input.orgId, { plateNumber: input.event.plateNumber });
      }
      emitEntryCandidateCreated(input.orgId, {
        candidateId: candidate.id,
        orgId: input.orgId,
        detectedPlate: candidate.detected_plate,
        cameraEventAt: new Date(candidate.camera_event_at).toISOString(),
        confidence: candidate.confidence === null ? null : Number(candidate.confidence),
        entryImages: websocketImages(candidate),
      });
    }
    return { created: false as const, reason: transactionResult.reason, candidateId: candidate.id };
  }

  const attachedSession = await attachWebhookEntryImages(transactionResult.session, input.event);
  const barrier = await recordEntryBarrierAttempt({
    actorId: null,
    orgId: input.orgId,
    sessionId: attachedSession.id,
    retryAttempt: false,
  });
  if (barrier.status === "failed") {
    emitEntryBarrierFailed(input.orgId, {
      sessionId: attachedSession.id,
      plateNumber: displayPlateNumber(attachedSession.plate_number),
      detail: barrier.detail,
    });
  } else if (barrier.status === "opened") {
    emitEntryCompleted(input.orgId, {
      sessionId: attachedSession.id,
      plateNumber: displayPlateNumber(attachedSession.plate_number),
      barrierStatus: barrier.status,
    });
  }
  emitEntryDetected(input.orgId, {
    plateNumber: displayPlateNumber(attachedSession.plate_number),
    enteredAt: attachedSession.entered_at,
  });
  return {
    created: true as const,
    session: attachedSession,
    confidence: input.event.confidence,
    barrierStatus: barrier.status,
  };
}

export async function getNextEntryCandidate(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const [{ count }] = await db("tb_entry_candidates")
    .where({ org_id: orgId, status: "pending" })
    .count<{ count: string }[]>("id as count");
  const candidate = await candidateQuery()
    .where({ "tb_entry_candidates.org_id": orgId, "tb_entry_candidates.status": "pending" })
    .orderBy("tb_entry_candidates.created_at", "asc")
    .orderBy("tb_entry_candidates.id", "asc")
    .first();
  if (!candidate) return null;
  return {
    candidate_id: candidate.id,
    detected_plate: candidate.detected_plate,
    reason: candidate.reason,
    camera_event_at: candidate.camera_event_at,
    confidence: candidate.confidence === null ? null : Number(candidate.confidence),
    entry_images: await entryImages(actor, candidate),
    pending_count_for_org: Number(count),
  };
}

export async function acceptEntryCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  input: { plateNumber: string; note?: string }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const transactionResult = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const candidate = await trx<EntryCandidateRow>("tb_entry_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Kirish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu kirish allaqachon hal qilingan", 409);
    const plateNumber = normalizePlate(input.plateNumber);
    if (!plateNumber) throw new ApiError("Davlat raqami kiritilishi kerak", 400);
    const session = await createEntrySessionInTransaction(trx, {
      orgId,
      plateNumber,
      entryMethod: "auto",
      operatorId: actor.id,
      enteredAt: new Date(candidate.camera_event_at),
      skipCapacity: true,
      skipWorkHours: true,
    });
    const resolvedAt = new Date();
    await trx("tb_entry_candidates").where({ id: candidate.id, org_id: orgId }).update({
      status: "accepted",
      resolution_type: "accepted",
      resolved_session_id: session.id,
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      note: input.note?.trim().slice(0, 500) || null,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "entry_candidate_accepted",
      processing_reason: "operator_accepted_entry",
      session_id: session.id,
      processed_at: trx.fn.now(),
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "parking.entry_candidate_accepted",
      target_type: "entry_candidate",
      target_id: candidate.id,
      details: JSON.stringify({
        orgId,
        candidateId: candidate.id,
        plateNumber,
        note: input.note?.trim().slice(0, 500) || null,
        sessionId: session.id,
      }),
    });
    return { candidate, session };
  });
  const barrier = await recordEntryBarrierAttempt({
    actorId: actor.id,
    orgId,
    sessionId: transactionResult.session.id,
    retryAttempt: false,
  });
  if (barrier.status === "failed") {
    emitEntryBarrierFailed(orgId, {
      sessionId: transactionResult.session.id,
      plateNumber: displayPlateNumber(transactionResult.session.plate_number),
      detail: barrier.detail,
    });
  } else if (barrier.status === "opened") {
    emitEntryCompleted(orgId, {
      sessionId: transactionResult.session.id,
      plateNumber: displayPlateNumber(transactionResult.session.plate_number),
      barrierStatus: barrier.status,
    });
  }
  emitEntryCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "accepted",
    sessionId: transactionResult.session.id,
    barrierStatus: barrier.status,
  });
  return {
    session_id: transactionResult.session.id,
    plate: displayPlateNumber(transactionResult.session.plate_number),
    barrier_status: barrier.status,
  };
}

export async function createManualEntry(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { plateNumber: string; reason: string; note?: string }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const plateNumber = normalizePlate(input.plateNumber);
  if (!plateNumber) throw new ApiError("Davlat raqami kiritilishi kerak", 400);
  const reason = input.reason.trim().slice(0, 100);
  if (!reason) throw new ApiError("reason majburiy", 400);
  const note = input.note?.trim().slice(0, 500) || null;
  const session = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const created = await createEntrySessionInTransaction(trx, {
      orgId,
      plateNumber,
      entryMethod: "manual",
      operatorId: actor.id,
      enteredAt: new Date(),
      skipCapacity: true,
      skipWorkHours: true,
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "parking.manual_entry",
      target_type: "session",
      target_id: created.id,
      details: JSON.stringify({
        operatorId: actor.id,
        orgId,
        plateNumber,
        reason,
        note,
      }),
    });
    return created;
  });
  const barrier = await recordEntryBarrierAttempt({
    actorId: actor.id,
    orgId,
    sessionId: session.id,
    retryAttempt: false,
  });
  if (barrier.status === "failed") {
    emitEntryBarrierFailed(orgId, {
      sessionId: session.id,
      plateNumber: displayPlateNumber(session.plate_number),
      detail: barrier.detail,
    });
  } else if (barrier.status === "opened") {
    emitEntryCompleted(orgId, {
      sessionId: session.id,
      plateNumber: displayPlateNumber(session.plate_number),
      barrierStatus: barrier.status,
    });
  }
  emitEntryDetected(orgId, {
    plateNumber: displayPlateNumber(session.plate_number),
    enteredAt: session.entered_at,
  });
  return {
    session_id: session.id,
    plate: displayPlateNumber(session.plate_number),
    barrier_status: barrier.status,
  };
}

export async function declineEntryCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  note?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await db.transaction(async (trx) => {
    const candidate = await trx<EntryCandidateRow>("tb_entry_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Kirish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu kirish allaqachon hal qilingan", 409);
    const resolvedAt = new Date();
    await trx("tb_entry_candidates").where({ id: candidate.id, org_id: orgId }).update({
      status: "declined",
      resolution_type: "declined",
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      note: note?.trim() || null,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "entry_candidate_declined",
      processing_reason: "operator_declined_entry",
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "parking.entry_candidate_declined",
      target_type: "entry_candidate",
      target_id: candidate.id,
      details: JSON.stringify({
        orgId,
        candidateId: candidate.id,
        plate: displayPlateNumber(candidate.detected_plate),
        note: note?.trim() || null,
      }),
    });
  });
  emitEntryCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "declined",
    sessionId: null,
    barrierStatus: null,
  });
  return { status: "declined" as const };
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

export async function retryEntryBarrier(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  sessionId: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const session = await db<Pick<SessionRecord, "id" | "org_id" | "plate_number">>("tb_parking_sessions")
    .select("id", "org_id", "plate_number")
    .where({ id: sessionId, org_id: orgId })
    .first();
  if (!session) throw new ApiError("Sessiya topilmadi", 404);
  const audit = await db("tb_activity_logs")
    .where({ target_type: "session", target_id: sessionId })
    .whereIn("action", ENTRY_BARRIER_AUDIT_ACTIONS)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .first();
  const details = parseActivityDetails(audit?.details);
  if (!audit || details.orgId !== orgId || details.barrierStatus !== "failed") {
    throw new ApiError("Faqat oxirgi shlagbaum urinishida xato bo'lsa qayta ochish mumkin", 400);
  }
  const barrier = await recordEntryBarrierAttempt({
    actorId: actor.id,
    orgId,
    sessionId,
    retryAttempt: true,
  });
  return { barrier_status: barrier.status };
}
