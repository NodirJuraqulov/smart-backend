import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdRequired } from "@/utils/orgScope";

type EmergencyExitType = "confirmed" | "forced_open";

interface EmergencyExitHistoryRow {
  id: string;
  source: "parking_session" | "exit_candidate";
  session_id: number | null;
  candidate_id: number | null;
  webhook_event_id: number | null;
  plate_number: string | null;
  occurred_at: Date;
  confirmed_by_id: number | null;
  confirmed_by_name: string | null;
  exit_type: EmergencyExitType;
  resolution_note: string | null;
  overview_image_path: string | null;
  vehicle_image_path: string | null;
  plate_image_path: string | null;
}

function imageUrl(row: EmergencyExitHistoryRow): string | null {
  if (!row.webhook_event_id) return null;
  if (row.overview_image_path) {
    return `/api/webhook-events/${row.webhook_event_id}/images/overview`;
  }
  if (row.vehicle_image_path) {
    return `/api/webhook-events/${row.webhook_event_id}/images/vehicle`;
  }
  if (row.plate_image_path) {
    return `/api/webhook-events/${row.webhook_event_id}/images/plate`;
  }
  return null;
}

function confirmedCandidateLinks(orgId: number) {
  return db("tb_exit_candidates")
    .select("resolved_session_id")
    .max("id as candidate_id")
    .where({ org_id: orgId, resolution_type: "emergency_confirmed" })
    .whereNotNull("resolved_session_id")
    .groupBy("resolved_session_id");
}

function sessionHistoryQuery(orgId: number) {
  return db("tb_parking_sessions as session")
    .leftJoin(
      confirmedCandidateLinks(orgId).as("candidate_link"),
      "candidate_link.resolved_session_id",
      "session.id"
    )
    .leftJoin("tb_exit_candidates as candidate", "candidate.id", "candidate_link.candidate_id")
    .leftJoin("tb_webhook_events as event", "event.id", "candidate.webhook_event_id")
    .leftJoin("tb_users as resolver", "resolver.id", "session.operator_id")
    .select(
      db.raw("CONCAT('session:', session.id) AS id"),
      db.raw("'parking_session' AS source"),
      "session.id as session_id",
      "candidate.id as candidate_id",
      "candidate.webhook_event_id",
      "session.plate_number",
      "session.exited_at as occurred_at",
      "session.operator_id as confirmed_by_id",
      "resolver.name as confirmed_by_name",
      db.raw("'confirmed' AS exit_type"),
      "candidate.resolution_note",
      "event.overview_image_path",
      "event.vehicle_image_path",
      "event.plate_image_path"
    )
    .where({ "session.org_id": orgId, "session.exit_method": "emergency" })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("tb_exit_candidates as forced_candidate")
        .whereRaw("forced_candidate.resolved_session_id = session.id")
        .andWhere({ "forced_candidate.resolution_type": "emergency_forced_open" });
    });
}

function forcedOpenHistoryQuery(orgId: number) {
  return db("tb_exit_candidates as candidate")
    .leftJoin("tb_parking_sessions as session", "session.id", "candidate.resolved_session_id")
    .leftJoin("tb_webhook_events as event", "event.id", "candidate.webhook_event_id")
    .leftJoin("tb_users as resolver", "resolver.id", "candidate.resolved_by")
    .select(
      db.raw("CONCAT('candidate:', candidate.id) AS id"),
      db.raw("'exit_candidate' AS source"),
      "candidate.resolved_session_id as session_id",
      "candidate.id as candidate_id",
      "candidate.webhook_event_id",
      db.raw("COALESCE(candidate.detected_plate, candidate.suggested_plate, session.plate_number) AS plate_number"),
      "candidate.resolved_at as occurred_at",
      "candidate.resolved_by as confirmed_by_id",
      "resolver.name as confirmed_by_name",
      db.raw("'forced_open' AS exit_type"),
      "candidate.resolution_note",
      "event.overview_image_path",
      "event.vehicle_image_path",
      "event.plate_image_path"
    )
    .where({
      "candidate.org_id": orgId,
      "candidate.resolution_type": "emergency_forced_open",
    });
}

function historyUnion(orgId: number) {
  return db.unionAll([sessionHistoryQuery(orgId), forcedOpenHistoryQuery(orgId)], true);
}

export async function listEmergencyExitHistory(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  input: { page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);

  const [{ count }] = await db
    .from(historyUnion(orgId).as("emergency_history"))
    .count<{ count: string }[]>("id as count");
  const total = Number(count);

  const rows = await db
    .from<EmergencyExitHistoryRow>(historyUnion(orgId).as("emergency_history"))
    .select("*")
    .orderBy("occurred_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);

  return {
    history: rows.map((row) => ({
      id: row.id,
      source: row.source,
      session_id: row.session_id,
      candidate_id: row.candidate_id,
      plate_number: row.plate_number,
      occurred_at: row.occurred_at,
      confirmed_by:
        row.confirmed_by_id === null
          ? null
          : {
              id: row.confirmed_by_id,
              name: row.confirmed_by_name,
            },
      type: row.exit_type,
      resolution_note: row.resolution_note,
      image_url: imageUrl(row),
    })),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      total_pages: Math.ceil(total / input.limit) || 1,
    },
  };
}
