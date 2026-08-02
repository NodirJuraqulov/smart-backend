import cron from "node-cron";
import { db } from "@/config/db";
import { emitEntryCandidateResolved } from "@/websocket/socketServer";

const EXPIRY_MINUTES = 10;
const EXPIRY_NOTE = "Avtomatik muddati tugadi (10 daqiqa javob berilmadi)";

export async function runEntryCandidatesExpiry(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRY_MINUTES * 60_000);
  const expired = await db.transaction(async (trx) => {
    const candidates = await trx("tb_entry_candidates")
      .select("id", "org_id", "webhook_event_id")
      .where({ status: "pending" })
      .andWhere("created_at", "<", cutoff)
      .forUpdate();
    const resolved: Array<{ id: number; orgId: number }> = [];
    for (const candidate of candidates) {
      const changed = await trx("tb_entry_candidates")
        .where({ id: candidate.id, org_id: candidate.org_id, status: "pending" })
        .update({
          status: "expired",
          note: EXPIRY_NOTE,
          resolved_at: now,
          updated_at: now,
        });
      if (!changed) continue;
      await trx("tb_webhook_events")
        .where({ id: candidate.webhook_event_id, org_id: candidate.org_id })
        .update({
          processing_result: "entry_candidate_expired",
          processing_reason: "operator_response_timeout",
        });
      await trx("tb_activity_logs").insert({
        actor_id: null,
        action: "parking.entry_candidate_expired",
        target_type: "entry_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId: candidate.org_id,
          candidateId: candidate.id,
          note: EXPIRY_NOTE,
        }),
      });
      resolved.push({ id: candidate.id, orgId: candidate.org_id });
    }
    return resolved;
  });
  for (const candidate of expired) {
    emitEntryCandidateResolved(candidate.orgId, {
      candidateId: candidate.id,
      orgId: candidate.orgId,
      status: "expired",
      sessionId: null,
      barrierStatus: null,
    });
  }
  return expired.length;
}

export function scheduleEntryCandidatesExpiryJob(): void {
  cron.schedule("* * * * *", async () => {
    try {
      await runEntryCandidatesExpiry();
    } catch (err) {
      console.error("Entry candidate muddatini tekshirishda xato:", err);
    }
  });
}
