import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdRequired } from "@/utils/orgScope";

interface ForcedOpenHistoryRow {
  id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  suggested_plate: string | null;
  resolved_at: Date;
  resolved_by: number | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  overview_image_path: string | null;
  vehicle_image_path: string | null;
  plate_image_path: string | null;
}

function imageUrl(row: ForcedOpenHistoryRow): string | null {
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

export async function listForcedOpenHistory(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  input: { page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);

  const [{ count }] = await db("tb_exit_candidates")
    .where({ org_id: orgId, resolution_type: "forced_open" })
    .count<{ count: string }[]>("id as count");
  const total = Number(count);

  const rows = await db<ForcedOpenHistoryRow>("tb_exit_candidates")
    .leftJoin("tb_users as resolver", "resolver.id", "tb_exit_candidates.resolved_by")
    .leftJoin("tb_webhook_events", "tb_webhook_events.id", "tb_exit_candidates.webhook_event_id")
    .select(
      "tb_exit_candidates.id",
      "tb_exit_candidates.webhook_event_id",
      "tb_exit_candidates.detected_plate",
      "tb_exit_candidates.suggested_plate",
      "tb_exit_candidates.resolved_at",
      "tb_exit_candidates.resolved_by",
      "resolver.name as resolved_by_name",
      "tb_exit_candidates.resolution_note",
      "tb_webhook_events.overview_image_path",
      "tb_webhook_events.vehicle_image_path",
      "tb_webhook_events.plate_image_path"
    )
    .where({
      "tb_exit_candidates.org_id": orgId,
      "tb_exit_candidates.resolution_type": "forced_open",
    })
    .orderBy("tb_exit_candidates.resolved_at", "desc")
    .orderBy("tb_exit_candidates.id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);

  return {
    history: rows.map((row) => ({
      id: row.id,
      plate_number: row.detected_plate ?? row.suggested_plate,
      resolved_at: row.resolved_at,
      resolved_by:
        row.resolved_by === null
          ? null
          : {
              id: row.resolved_by,
              name: row.resolved_by_name,
            },
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
