import { DateTime } from "luxon";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdRequired } from "@/utils/orgScope";

interface CancelledExitHistoryRow {
  id: number;
  detected_plate: string | null;
  confidence: string | number | null;
  camera_event_at: Date;
  resolved_at: Date | null;
  resolved_by: number | null;
  resolved_by_name: string | null;
  resolved_by_login: string | null;
  webhook_event_id: number;
  overview_image_path: string | null;
  vehicle_image_path: string | null;
  plate_image_path: string | null;
}

function validDate(value: string, timezone: string): DateTime | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  return date.isValid && date.toFormat("yyyy-MM-dd") === value ? date : null;
}

function imageUrl(row: CancelledExitHistoryRow): string | null {
  if (row.overview_image_path) return `/api/webhook-events/${row.webhook_event_id}/images/overview`;
  if (row.vehicle_image_path) return `/api/webhook-events/${row.webhook_event_id}/images/vehicle`;
  if (row.plate_image_path) return `/api/webhook-events/${row.webhook_event_id}/images/plate`;
  return null;
}

export async function listCancelledExitHistory(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { from: string; to: string; page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const organization = await db("tb_organizations").select("timezone").where({ id: orgId }).first();
  const timezone = organization?.timezone ?? "Asia/Tashkent";
  const fromDate = validDate(input.from, timezone);
  const toDate = validDate(input.to, timezone);
  if (!fromDate || !toDate) throw new ApiError("from va to YYYY-MM-DD formatida bo'lishi kerak", 400);
  const days = Math.round(toDate.diff(fromDate, "days").days) + 1;
  if (days < 1 || days > 31) throw new ApiError("Sana oralig'i 31 kundan oshmasligi kerak", 400);

  const fromSeconds = Math.floor(fromDate.toSeconds());
  const toExclusiveSeconds = Math.floor(toDate.plus({ days: 1 }).toSeconds());
  const range = db.raw(
    "?? >= FROM_UNIXTIME(?) AND ?? < FROM_UNIXTIME(?)",
    ["candidate.camera_event_at", fromSeconds, "candidate.camera_event_at", toExclusiveSeconds]
  );
  const baseQuery = db("tb_exit_candidates as candidate")
    .where({
      "candidate.org_id": orgId,
      "candidate.resolution_type": "exit_cancelled",
    })
    .where(range);
  const [{ count }] = await baseQuery.clone().count<{ count: string }[]>({ count: "candidate.id" });
  const rows = await baseQuery
    .clone()
    .leftJoin("tb_users as resolver", "resolver.id", "candidate.resolved_by")
    .leftJoin("tb_webhook_events as event", "event.id", "candidate.webhook_event_id")
    .select<CancelledExitHistoryRow[]>(
      "candidate.id",
      "candidate.detected_plate",
      "candidate.confidence",
      "candidate.camera_event_at",
      "candidate.resolved_at",
      "candidate.resolved_by",
      "resolver.name as resolved_by_name",
      "resolver.login as resolved_by_login",
      "candidate.webhook_event_id",
      "event.overview_image_path",
      "event.vehicle_image_path",
      "event.plate_image_path"
    )
    .orderBy("candidate.camera_event_at", "desc")
    .orderBy("candidate.id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  const total = Number(count);

  return {
    history: rows.map((row) => {
      const url = imageUrl(row);
      return {
        id: row.id,
        detected_plate: row.detected_plate,
        confidence: row.confidence === null ? null : Number(row.confidence),
        camera_event_at: row.camera_event_at,
        resolved_at: row.resolved_at,
        resolved_by:
          row.resolved_by === null
            ? null
            : { id: row.resolved_by, name: row.resolved_by_name || row.resolved_by_login },
        webhook_event_id: row.webhook_event_id,
        has_image: url !== null,
        image_url: url,
      };
    }),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / input.limit)),
    },
  };
}
