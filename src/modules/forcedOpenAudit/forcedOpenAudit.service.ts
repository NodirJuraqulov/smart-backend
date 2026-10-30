import type { Knex } from "knex";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  calculateDurationMinutes,
  calculateTariffSnapshotAmount,
  SessionRecord,
} from "@/modules/parking/parking.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import { getOrganizationShiftWindow } from "@/utils/shiftWindow";
import { canonicalizePlate, plateDistance, similarityPercent } from "@/modules/exitCandidates/plateMatch";

const FORCED_OPEN_TYPES = ["forced_open", "emergency_forced_open"];

type AuditSession = Pick<
  SessionRecord,
  | "id"
  | "org_id"
  | "plate_number"
  | "entered_at"
  | "status"
  | "exit_method"
  | "session_source"
  | "tariff_price_per_hour"
  | "tariff_grace_period_minutes"
  | "tariff_intervals_snapshot"
>;

interface CandidateRow {
  id: number;
  org_id: number;
  webhook_event_id: number | null;
  detected_plate: string | null;
  confidence: string | number | null;
  matched_session_id: number | null;
  resolved_session_id: number | null;
  resolved_by: number | null;
  resolved_at: Date;
  resolution_type: string;
  operator_name: string | null;
  operator_login: string | null;
  overview_image_path: string | null;
  review_id: number | null;
  session_id: number | null;
  session_plate: string | null;
  entered_at: Date | null;
  session_status: AuditSession["status"] | null;
  exit_method: AuditSession["exit_method"] | null;
  session_source: AuditSession["session_source"] | null;
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: AuditSession["tariff_intervals_snapshot"] | null;
}

interface ReviewRow {
  id: number;
  org_id: number;
  candidate_id: number;
  operator_id: number | null;
  operator_name: string;
  forced_at: Date;
  detected_plate: string | null;
  webhook_event_id: number | null;
  session_id: number | null;
  session_plate: string | null;
  entered_at: Date | null;
  duration_minutes: number | null;
  amount_som: string | number;
  kind: "not_found" | "session_found";
  saved_by: number | null;
  created_at: Date;
}

function candidateSessionId(candidate: Pick<CandidateRow, "session_id">) {
  return candidate.session_id;
}

function candidateKind(candidate: Pick<CandidateRow, "session_id">) {
  return candidateSessionId(candidate) === null ? "not_found" as const : "session_found" as const;
}

function imageFields(eventId: number | null, overviewPath: string | null) {
  const hasImage = eventId !== null && overviewPath !== null;
  return {
    has_image: hasImage,
    image_url: hasImage ? `/api/webhook-events/${eventId}/images/overview` : null,
  };
}

function sessionAmount(
  session: Pick<
    AuditSession,
    | "session_source"
    | "tariff_price_per_hour"
    | "tariff_grace_period_minutes"
    | "tariff_intervals_snapshot"
  >,
  durationMinutes: number
) {
  return calculateTariffSnapshotAmount(session, durationMinutes);
}

async function organizationTimezone(orgId: number, executor: Knex = db): Promise<string> {
  const organization = await executor("tb_organizations").select("timezone").where({ id: orgId }).first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
  return organization.timezone ?? "Asia/Tashkent";
}

async function assertOperator(orgId: number, operatorId: number, executor: Knex = db): Promise<void> {
  const operator = await executor("tb_users")
    .select("id")
    .where({ id: operatorId, org_id: orgId, role: "operator" })
    .first();
  if (!operator) throw new ApiError("Operator topilmadi", 404);
}

function candidateQuery(executor: Knex) {
  return executor<CandidateRow>("tb_exit_candidates as candidate")
    .leftJoin("tb_users as operator", "operator.id", "candidate.resolved_by")
    .leftJoin("tb_webhook_events as event", function joinEvent() {
      this.on("event.id", "=", "candidate.webhook_event_id").andOn("event.org_id", "=", "candidate.org_id");
    })
    .leftJoin("forced_open_reviews as review", function joinReview() {
      this.on("review.candidate_id", "=", "candidate.id").andOn("review.org_id", "=", "candidate.org_id");
    })
    .leftJoin("tb_parking_sessions as session", function joinSession() {
      this.on(
        "session.id",
        "=",
        db.raw("COALESCE(??, ??)", ["candidate.resolved_session_id", "candidate.matched_session_id"])
      )
        .andOn("session.org_id", "=", "candidate.org_id");
    })
    .select(
      "candidate.id",
      "candidate.org_id",
      "candidate.webhook_event_id",
      "candidate.detected_plate",
      "candidate.confidence",
      "candidate.matched_session_id",
      "candidate.resolved_session_id",
      "candidate.resolved_by",
      "candidate.resolved_at",
      "candidate.resolution_type",
      "operator.name as operator_name",
      "operator.login as operator_login",
      "event.overview_image_path",
      "review.id as review_id",
      "session.id as session_id",
      "session.plate_number as session_plate",
      "session.entered_at",
      "session.status as session_status",
      "session.exit_method",
      "session.session_source",
      "session.tariff_price_per_hour",
      "session.tariff_grace_period_minutes",
      "session.tariff_intervals_snapshot"
    );
}

async function loadForcedCandidate(orgId: number, candidateId: number, executor: Knex = db) {
  const candidate = await candidateQuery(executor)
    .where({ "candidate.id": candidateId, "candidate.org_id": orgId })
    .whereIn("candidate.resolution_type", FORCED_OPEN_TYPES)
    .first();
  if (!candidate) throw new ApiError("Majburiy ochish nomzodi topilmadi", 404);
  return candidate;
}

export async function listForcedOpenAudit(
  actor: AuthTokenPayload,
  operatorId: number,
  date: string
) {
  const orgId = resolveOrgIdRequired(actor);
  await assertOrganizationExists(orgId);
  await assertOperator(orgId, operatorId);
  const timezone = await organizationTimezone(orgId);
  const window = getOrganizationShiftWindow(date, timezone);
  const rows = await candidateQuery(db)
    .where({ "candidate.org_id": orgId, "candidate.resolved_by": operatorId })
    .whereIn("candidate.resolution_type", FORCED_OPEN_TYPES)
    .andWhere("candidate.resolved_at", ">=", window.from)
    .andWhere("candidate.resolved_at", "<", window.to)
    .orderBy("candidate.resolved_at", "asc")
    .orderBy("candidate.id", "asc");

  return rows.map((row) => {
    const kind = candidateKind(row);
    const forcedAt = new Date(row.resolved_at);
    const enteredAt = row.entered_at ? new Date(row.entered_at) : null;
    const durationMinutes = enteredAt ? calculateDurationMinutes(enteredAt, forcedAt) : null;
    const amount =
      durationMinutes !== null && row.session_source !== null
        ? sessionAmount(
            {
              session_source: row.session_source,
              tariff_price_per_hour: row.tariff_price_per_hour,
              tariff_grace_period_minutes: row.tariff_grace_period_minutes,
              tariff_intervals_snapshot: row.tariff_intervals_snapshot,
            },
            durationMinutes
          )
        : null;
    return {
      candidate_id: row.id,
      forced_at: forcedAt,
      detected_plate: row.detected_plate,
      confidence: row.confidence === null ? null : Number(row.confidence),
      webhook_event_id: row.webhook_event_id,
      ...imageFields(row.webhook_event_id, row.overview_image_path),
      kind,
      session:
        kind === "session_found" && row.session_id !== null && enteredAt !== null
          ? {
              session_id: row.session_id,
              plate_number: row.session_plate,
              entered_at: enteredAt,
              duration_minutes: durationMinutes,
              amount_som: amount,
              forced_closed:
                row.resolved_session_id !== null &&
                row.session_status === "completed" &&
                (row.exit_method === "forced" || row.exit_method === "emergency"),
            }
          : null,
      review_id: row.review_id,
    };
  });
}

export async function searchForcedOpenSessions(
  actor: AuthTokenPayload,
  candidateId: number,
  plate: string
) {
  const orgId = resolveOrgIdRequired(actor);
  const candidate = await loadForcedCandidate(orgId, candidateId);
  if (candidateKind(candidate) !== "not_found") {
    throw new ApiError("Sessiya topilgan nomzod uchun qidiruv mumkin emas", 409);
  }
  if (canonicalizePlate(plate).length < 3) return [];
  const forcedAt = new Date(candidate.resolved_at);
  const sessions = await db<AuditSession>("tb_parking_sessions")
    .select(
      "id",
      "org_id",
      "plate_number",
      "entered_at",
      "status",
      "exit_method",
      "session_source",
      "tariff_price_per_hour",
      "tariff_grace_period_minutes",
      "tariff_intervals_snapshot"
    )
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number")
    .andWhere("entered_at", "<", forcedAt);
  return sessions
    .map((session) => ({
      session,
      distance: plateDistance(plate, session.plate_number ?? ""),
      similarity: similarityPercent(plate, session.plate_number ?? ""),
    }))
    .filter(
      ({ session, distance }) =>
        canonicalizePlate(session.plate_number ?? "").length >= 3 && distance <= 2
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        new Date(right.session.entered_at).getTime() - new Date(left.session.entered_at).getTime() ||
        right.session.id - left.session.id
    )
    .slice(0, 10)
    .map(({ session, similarity }) => {
      const enteredAt = new Date(session.entered_at);
      const durationMinutes = calculateDurationMinutes(enteredAt, forcedAt);
      return {
        session_id: session.id,
        plate_number: session.plate_number,
        entered_at: enteredAt,
        duration_minutes: durationMinutes,
        amount_som: sessionAmount(session, durationMinutes),
        similarity,
      };
    });
}

function serializeReview(row: ReviewRow) {
  return {
    ...row,
    amount_som: Number(row.amount_som),
  };
}

export async function createForcedOpenReview(
  actor: AuthTokenPayload,
  candidateId: number,
  requestedSessionId?: number
) {
  const orgId = resolveOrgIdRequired(actor);
  try {
    return await db.transaction(async (trx) => {
      const locked = await trx("tb_exit_candidates")
        .select("id")
        .where({ id: candidateId, org_id: orgId })
        .forUpdate()
        .first();
      if (!locked) throw new ApiError("Majburiy ochish nomzodi topilmadi", 404);
      const existing = await trx("forced_open_reviews")
        .select("id")
        .where({ org_id: orgId, candidate_id: candidateId })
        .first();
      if (existing) throw new ApiError("Bu majburiy ochish allaqachon saqlangan", 409);
      const candidate = await loadForcedCandidate(orgId, candidateId, trx);
      const kind = candidateKind(candidate);
      const sessionId = kind === "session_found" ? candidateSessionId(candidate) : requestedSessionId;
      if (sessionId === undefined || sessionId === null) {
        throw new ApiError("session_id majburiy", 400);
      }
      const session = await trx<AuditSession>("tb_parking_sessions")
        .select(
          "id",
          "org_id",
          "plate_number",
          "entered_at",
          "status",
          "exit_method",
          "session_source",
          "tariff_price_per_hour",
          "tariff_grace_period_minutes",
          "tariff_intervals_snapshot"
        )
        .where({ id: sessionId, org_id: orgId })
        .first();
      if (!session) throw new ApiError("Sessiya topilmadi", 404);
      const forcedAt = new Date(candidate.resolved_at);
      const enteredAt = new Date(session.entered_at);
      if (enteredAt.getTime() >= forcedAt.getTime()) {
        throw new ApiError("Sessiya majburiy ochishdan oldin kirgan bo'lishi kerak", 409);
      }
      const durationMinutes = calculateDurationMinutes(enteredAt, forcedAt);
      const amount = sessionAmount(session, durationMinutes);
      if (amount === null) throw new ApiError("Sessiya tarif snapshoti topilmadi", 409);
      const [id] = await trx("forced_open_reviews").insert({
        org_id: orgId,
        candidate_id: candidate.id,
        operator_id: candidate.resolved_by,
        operator_name: candidate.operator_name || candidate.operator_login || "Noma'lum",
        forced_at: forcedAt,
        detected_plate: candidate.detected_plate,
        webhook_event_id: candidate.webhook_event_id,
        session_id: session.id,
        session_plate: session.plate_number,
        entered_at: enteredAt,
        duration_minutes: durationMinutes,
        amount_som: amount,
        kind,
        saved_by: actor.id,
      });
      await trx("tb_activity_logs").insert({
        actor_id: actor.id,
        action: "forced_open_review.saved",
        target_type: "forced_open_review",
        target_id: id,
        details: JSON.stringify({
          orgId,
          candidateId: candidate.id,
          operatorId: candidate.resolved_by,
          sessionId: session.id,
          durationMinutes,
          amountSom: amount,
          kind,
        }),
      });
      const created = await trx<ReviewRow>("forced_open_reviews").where({ id }).first();
      if (!created) throw new ApiError("Tekshiruv yozuvi yaratilmadi", 500);
      return serializeReview(created);
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError("Bu majburiy ochish allaqachon saqlangan", 409);
    }
    throw error;
  }
}

export async function getForcedOpenReviewSummary(
  orgId: number,
  operatorId: number,
  from: Date,
  to: Date,
  executor: Knex = db
) {
  const [row] = await executor("forced_open_reviews")
    .where({ org_id: orgId, operator_id: operatorId })
    .andWhere("forced_at", ">=", from)
    .andWhere("forced_at", "<", to)
    .count<{ count: string }[]>("id as count")
    .sum<{ count: string; amount_som: string | null }[]>("amount_som as amount_som");
  return {
    count: Number(row?.count ?? 0),
    amount_som: Number(row?.amount_som ?? 0),
  };
}

export async function listForcedOpenReviews(
  actor: AuthTokenPayload,
  operatorId: number,
  date: string
) {
  const orgId = resolveOrgIdRequired(actor);
  await assertOrganizationExists(orgId);
  await assertOperator(orgId, operatorId);
  const timezone = await organizationTimezone(orgId);
  const window = getOrganizationShiftWindow(date, timezone);
  const rows = await db<ReviewRow & { overview_image_path: string | null }>("forced_open_reviews as review")
    .leftJoin("tb_webhook_events as event", function joinEvent() {
      this.on("event.id", "=", "review.webhook_event_id").andOn("event.org_id", "=", "review.org_id");
    })
    .select("review.*", "event.overview_image_path")
    .where({ "review.org_id": orgId, "review.operator_id": operatorId })
    .andWhere("review.forced_at", ">=", window.from)
    .andWhere("review.forced_at", "<", window.to)
    .orderBy("review.forced_at", "asc")
    .orderBy("review.id", "asc");
  const total = await getForcedOpenReviewSummary(orgId, operatorId, window.from, window.to);
  return {
    operator_id: operatorId,
    from: window.from,
    to: window.to,
    items: rows.map((row) => ({
      review_id: row.id,
      forced_at: new Date(row.forced_at),
      detected_plate: row.detected_plate,
      session_plate: row.session_plate,
      entered_at: row.entered_at ? new Date(row.entered_at) : null,
      duration_minutes: row.duration_minutes,
      amount_som: Number(row.amount_som),
      kind: row.kind,
      ...imageFields(row.webhook_event_id, row.overview_image_path),
    })),
    total,
  };
}
