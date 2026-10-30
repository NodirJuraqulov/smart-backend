import { DateTime } from "luxon";
import type { Knex } from "knex";
import { db } from "@/config/db";
import { env } from "@/config/env";
import {
  findActiveInpatientVehicleForExit,
  getOrgTodayDate,
  getOrgTodayRange,
} from "@/modules/medplus/medplus.service";

interface OrganizationRow {
  id: number;
  timezone: string | null;
  is_active: boolean | number;
}

interface SessionRow {
  id: number;
  org_id: number;
  plate_number: string | null;
  status: string;
  session_source: string;
}

interface OrganizationCleanupSummary {
  candidates: number;
  deleted_sessions: number;
  skipped: {
    inpatient: number;
    payment: number;
    terminal: number;
  };
  related: {
    exit_candidates: number;
    entry_candidates: number;
    webhook_events: number;
    activity_logs: number;
    terminal_operations: number;
  };
  limit_exceeded: boolean;
}

export interface StaleSessionsCleanupSummary {
  organizations: number;
  candidates: number;
  deleted_sessions: number;
  skipped: {
    inpatient: number;
    payment: number;
    terminal: number;
  };
  related: {
    exit_candidates: number;
    entry_candidates: number;
    webhook_events: number;
    activity_logs: number;
    terminal_operations: number;
  };
  limit_exceeded_orgs: number;
  failed_orgs: number;
}

const PROTECTED_TERMINAL_STATUSES = ["APPROVED", "FIN_FAILED", "ORPHANED"];

function emptyOrganizationSummary(): OrganizationCleanupSummary {
  return {
    candidates: 0,
    deleted_sessions: 0,
    skipped: { inpatient: 0, payment: 0, terminal: 0 },
    related: {
      exit_candidates: 0,
      entry_candidates: 0,
      webhook_events: 0,
      activity_logs: 0,
      terminal_operations: 0,
    },
    limit_exceeded: false,
  };
}

function activeRegularSessionIds(trx: Knex.Transaction, sessionIds: number[]) {
  return trx("tb_parking_sessions")
    .select("id")
    .whereIn("id", sessionIds)
    .where({ status: "active", session_source: "regular" });
}

async function cleanupOrganization(
  organization: Pick<OrganizationRow, "id" | "timezone">
): Promise<OrganizationCleanupSummary> {
  const timezone = organization.timezone || "Asia/Tashkent";
  const todayStart = getOrgTodayRange(timezone).start;
  const cutoff = DateTime.fromJSDate(todayStart)
    .setZone(timezone)
    .minus({ days: env.staleSessionCleanup.keepDays - 1 })
    .toJSDate();
  return db.transaction(async (trx) => {
    const summary = emptyOrganizationSummary();
    const candidates = await trx<SessionRow>("tb_parking_sessions")
      .select("id", "plate_number")
      .where({ org_id: organization.id, status: "active", session_source: "regular" })
      .andWhere("entered_at", "<", cutoff)
      .orderBy("entered_at", "asc")
      .orderBy("id", "asc")
      .forUpdate();
    summary.candidates = candidates.length;
    if (candidates.length === 0) return summary;
    const candidateIds = candidates.map((session) => session.id);
    const [paymentRows, terminalRows] = await Promise.all([
      trx("tb_payments").select("session_id").whereIn("session_id", candidateIds),
      trx("payment_terminal_operations")
        .select("session_id")
        .whereIn("session_id", candidateIds)
        .whereIn("status", PROTECTED_TERMINAL_STATUSES),
    ]);
    const paymentSessionIds = new Set<number>(paymentRows.map((row) => Number(row.session_id)));
    const terminalSessionIds = new Set<number>(terminalRows.map((row) => Number(row.session_id)));
    const inpatientSessionIds = new Set<number>();
    const todayDate = getOrgTodayDate(timezone);
    for (const session of candidates) {
      if (!session.plate_number) continue;
      const inpatient = await findActiveInpatientVehicleForExit(
        organization.id,
        session.plate_number,
        todayDate,
        trx
      );
      if (inpatient) inpatientSessionIds.add(session.id);
    }
    const deletableIds: number[] = [];
    for (const session of candidates) {
      if (inpatientSessionIds.has(session.id)) {
        summary.skipped.inpatient += 1;
        console.warn(`STALE_SESSION_CLEANUP_SKIPPED org_id=${organization.id} session_id=${session.id} reason=inpatient`);
      } else if (paymentSessionIds.has(session.id)) {
        summary.skipped.payment += 1;
        console.warn(`STALE_SESSION_CLEANUP_SKIPPED org_id=${organization.id} session_id=${session.id} reason=payment`);
      } else if (terminalSessionIds.has(session.id)) {
        summary.skipped.terminal += 1;
        console.warn(`STALE_SESSION_CLEANUP_SKIPPED org_id=${organization.id} session_id=${session.id} reason=terminal_operation`);
      } else {
        deletableIds.push(session.id);
      }
    }
    if (deletableIds.length > env.staleSessionCleanup.maxPerRun) {
      summary.limit_exceeded = true;
      console.error(
        `STALE_SESSION_CLEANUP_LIMIT_EXCEEDED org_id=${organization.id} count=${deletableIds.length} max=${env.staleSessionCleanup.maxPerRun}`
      );
      return summary;
    }
    if (deletableIds.length === 0) return summary;
    const activeIds = () => activeRegularSessionIds(trx, deletableIds);
    summary.related.exit_candidates = await trx("tb_exit_candidates")
      .where((query) => {
        query
          .whereIn("matched_session_id", activeIds())
          .orWhereIn("resolved_session_id", activeIds());
      })
      .andWhere((query) => {
        query
          .whereNull("resolution_type")
          .orWhereNotIn("resolution_type", ["forced_open", "emergency_forced_open"])
          .orWhereNull("resolved_at")
          .orWhere(
            "resolved_at",
            "<",
            trx.raw("DATE_SUB(NOW(), INTERVAL ? DAY)", [env.forcedOpenRetentionDays])
          );
      })
      .del();
    summary.related.entry_candidates = await trx("tb_entry_candidates")
      .whereIn("resolved_session_id", activeIds())
      .del();
    summary.related.webhook_events = await trx("tb_webhook_events")
      .whereIn("session_id", activeIds())
      .whereNotExists(
        trx("forced_open_reviews as review")
          .select(trx.raw("1"))
          .whereRaw("review.webhook_event_id = tb_webhook_events.id")
      )
      .del();
    summary.related.activity_logs = await trx("tb_activity_logs")
      .where({ target_type: "session" })
      .whereIn("target_id", activeIds())
      .del();
    summary.related.terminal_operations = await trx("payment_terminal_operations")
      .whereIn("session_id", activeIds())
      .del();
    summary.deleted_sessions = await trx("tb_parking_sessions")
      .whereIn("id", deletableIds)
      .where({ status: "active", session_source: "regular" })
      .del();
    return summary;
  });
}

export async function runStaleSessionsCleanup(): Promise<StaleSessionsCleanupSummary> {
  const organizations = await db<OrganizationRow>("tb_organizations")
    .select("id", "timezone")
    .where({ is_active: true })
    .orderBy("id", "asc");
  const summary: StaleSessionsCleanupSummary = {
    organizations: organizations.length,
    candidates: 0,
    deleted_sessions: 0,
    skipped: { inpatient: 0, payment: 0, terminal: 0 },
    related: {
      exit_candidates: 0,
      entry_candidates: 0,
      webhook_events: 0,
      activity_logs: 0,
      terminal_operations: 0,
    },
    limit_exceeded_orgs: 0,
    failed_orgs: 0,
  };
  for (const organization of organizations) {
    try {
      const result = await cleanupOrganization(organization);
      summary.candidates += result.candidates;
      summary.deleted_sessions += result.deleted_sessions;
      summary.skipped.inpatient += result.skipped.inpatient;
      summary.skipped.payment += result.skipped.payment;
      summary.skipped.terminal += result.skipped.terminal;
      summary.related.exit_candidates += result.related.exit_candidates;
      summary.related.entry_candidates += result.related.entry_candidates;
      summary.related.webhook_events += result.related.webhook_events;
      summary.related.activity_logs += result.related.activity_logs;
      summary.related.terminal_operations += result.related.terminal_operations;
      if (result.limit_exceeded) summary.limit_exceeded_orgs += 1;
    } catch (error) {
      summary.failed_orgs += 1;
      console.error(`STALE_SESSION_CLEANUP_ORG_FAILED org_id=${organization.id}`, error);
    }
  }
  console.log(`STALE_SESSION_CLEANUP_SUMMARY ${JSON.stringify(summary)}`);
  return summary;
}
