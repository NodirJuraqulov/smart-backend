import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { emitExitCandidateResolved } from "@/websocket/socketServer";

const EXPIRY_MINUTES = 10;
const AUTOMATIC_EXPIRY_NOTE = "Avtomatik muddati tugadi (10 daqiqa javob berilmadi)";
const MANUAL_EXPIRY_NOTE = "Qo'lda tozalandi (deploy oldidan)";

interface ExitCandidateTableRow {
  id: number;
  org_id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  status: "pending" | "accepted" | "dismissed" | "expired";
  created_at: Date;
}

type PendingExitCandidate = Pick<
  ExitCandidateTableRow,
  "id" | "org_id" | "webhook_event_id" | "detected_plate"
>;

function emitExpiredCandidates(candidates: PendingExitCandidate[]): void {
  for (const candidate of candidates) {
    emitExitCandidateResolved(candidate.org_id, {
      candidateId: candidate.id,
      orgId: candidate.org_id,
      status: "expired",
      resolutionType: null,
      sessionId: null,
      barrierStatus: null,
      plateNumber: candidate.detected_plate,
    });
  }
}

export async function runExitCandidatesExpiry(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRY_MINUTES * 60_000);
  const expired = await db.transaction(async (trx) => {
    const candidates = await trx<ExitCandidateTableRow>("tb_exit_candidates")
      .select("id", "org_id", "webhook_event_id", "detected_plate")
      .where({ status: "pending" })
      .andWhere("created_at", "<", cutoff)
      .forUpdate();
    const resolved: PendingExitCandidate[] = [];
    for (const candidate of candidates) {
      const changed = await trx("tb_exit_candidates")
        .where({ id: candidate.id, org_id: candidate.org_id, status: "pending" })
        .update({
          status: "expired",
          resolution_note: AUTOMATIC_EXPIRY_NOTE,
          resolved_at: now,
          updated_at: now,
        });
      if (!changed) continue;
      await trx("tb_webhook_events")
        .where({ id: candidate.webhook_event_id, org_id: candidate.org_id })
        .update({
          processing_result: "exit_candidate_expired",
          processing_reason: "operator_response_timeout",
        });
      await trx("tb_activity_logs").insert({
        actor_id: null,
        action: "parking.exit_candidate_expired",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId: candidate.org_id,
          candidateId: candidate.id,
          note: AUTOMATIC_EXPIRY_NOTE,
        }),
      });
      resolved.push(candidate);
    }
    return resolved;
  });
  emitExpiredCandidates(expired);
  return expired.length;
}

export async function expirePendingExitCandidatesForOrganization(
  orgId: number,
  actorId: number,
  now = new Date()
): Promise<{ expiredCount: number }> {
  const expired = await db.transaction(async (trx) => {
    const organization = await trx("tb_organizations").select("id").where({ id: orgId }).forUpdate().first();
    if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
    const candidates = await trx<ExitCandidateTableRow>("tb_exit_candidates")
      .select("id", "org_id", "webhook_event_id", "detected_plate")
      .where({ org_id: orgId, status: "pending" })
      .forUpdate();
    if (candidates.length > 0) {
      const candidateIds = candidates.map((candidate) => candidate.id);
      const webhookEventIds = candidates.map((candidate) => candidate.webhook_event_id);
      await trx("tb_exit_candidates")
        .where({ org_id: orgId, status: "pending" })
        .whereIn("id", candidateIds)
        .update({
          status: "expired",
          resolution_note: MANUAL_EXPIRY_NOTE,
          resolved_at: now,
          updated_at: now,
        });
      await trx("tb_webhook_events")
        .where({ org_id: orgId })
        .whereIn("id", webhookEventIds)
        .update({
          processing_result: "exit_candidate_expired",
          processing_reason: "manual_predeployment_cleanup",
        });
    }
    await trx("tb_activity_logs").insert({
      actor_id: actorId,
      action: "organization.exit_candidates_expired",
      target_type: "organization",
      target_id: orgId,
      details: JSON.stringify({
        orgId,
        expiredCount: candidates.length,
        note: MANUAL_EXPIRY_NOTE,
      }),
    });
    return candidates;
  });
  emitExpiredCandidates(expired);
  return { expiredCount: expired.length };
}
