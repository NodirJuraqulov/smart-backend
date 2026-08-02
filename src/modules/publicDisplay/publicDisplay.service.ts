import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { applyInsideSessionsFilter } from "@/modules/parking/sessionStatus";
import {
  PublicBarrierStatus,
  PublicEntryDisplayStatus,
  PublicExitDisplayStatus,
  publicDisplayStateForBarrier,
} from "./publicDisplay.types";

const PENDING_WINDOW_MS = 60_000;
const COMPLETED_WINDOW_MS = 15_000;
const ENTRY_BARRIER_ACTIONS = [
  "parking.entry_barrier_opened",
  "parking.entry_barrier_open_failed",
  "parking.entry_barrier_unavailable",
];
const EXIT_BARRIER_ACTIONS = [
  "parking.exit_candidate_barrier_opened",
  "parking.exit_candidate_barrier_open_failed",
  "parking.exit_candidate_barrier_unavailable",
];

interface BarrierAudit {
  status: PublicBarrierStatus | null;
  createdAt: Date | null;
}

interface EntryCandidateDisplayRow {
  id: number;
  detected_plate: string | null;
  status: "pending" | "accepted" | "declined" | "expired";
  resolved_session_id: number | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  resolved_plate: string | null;
}

interface EntrySessionDisplayRow {
  id: number;
  plate_number: string | null;
  created_at: Date;
}

interface ExitCandidateDisplayRow {
  id: number;
  detected_plate: string | null;
  status: "pending" | "accepted" | "dismissed" | "expired";
  resolution_type: "exact" | "reassigned" | "dismissed" | "forced_open" | null;
  matched_session_id: number | null;
  resolved_session_id: number | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  matched_plate: string | null;
  matched_source: "regular" | "subscription" | "vip" | null;
  resolved_plate: string | null;
  resolved_source: "regular" | "subscription" | "vip" | null;
  resolved_amount: string | number | null;
  resolved_payment_method: "cash" | "online" | null;
  resolved_duration_minutes: number | null;
}

interface CompletedSessionDisplayRow {
  id: number;
  plate_number: string | null;
  session_source: "regular" | "subscription" | "vip";
  amount: string | number | null;
  payment_method: "cash" | "online";
  duration_minutes: number | null;
  exited_at: Date;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function latestDate(...values: Array<Date | null>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    return !latest || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function isWithinWindow(value: Date, now: Date, windowMs: number): boolean {
  const delta = now.getTime() - value.getTime();
  return delta >= -1_000 && delta <= windowMs;
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

function parseBarrierStatus(value: unknown): PublicBarrierStatus | null {
  return value === "opened" || value === "failed" || value === "disabled" || value === "not_configured"
    ? value
    : null;
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function assertPublicOrganization(orgId: number): Promise<void> {
  const organization = await db("tb_organizations").select("id").where({ id: orgId }).first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
}

async function getLatestBarrierAudit(
  orgId: number,
  targetType: "session" | "exit_candidate",
  targetId: number,
  actions: string[]
): Promise<BarrierAudit> {
  const audit = await db("tb_activity_logs")
    .select("details", "created_at")
    .where({ target_type: targetType, target_id: targetId })
    .whereIn("action", actions)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .first();
  if (!audit) return { status: null, createdAt: null };
  const details = parseActivityDetails(audit.details);
  if (Number(details.orgId) !== orgId) return { status: null, createdAt: null };
  return {
    status: parseBarrierStatus(details.barrierStatus),
    createdAt: asDate(audit.created_at),
  };
}

function idleEntryStatus(now: Date): PublicEntryDisplayStatus {
  return {
    state: "idle",
    plate: null,
    barrier_status: null,
    updated_at: now.toISOString(),
  };
}

function idleExitStatus(now: Date): PublicExitDisplayStatus {
  return {
    ...idleEntryStatus(now),
    session_source: null,
    amount: null,
    payment_method: null,
    duration_minutes: null,
  };
}

async function getLatestEntryCandidate(orgId: number): Promise<EntryCandidateDisplayRow | undefined> {
  return db({ candidate: "tb_entry_candidates" })
    .leftJoin({ session: "tb_parking_sessions" }, "session.id", "candidate.resolved_session_id")
    .select(
      "candidate.id",
      "candidate.detected_plate",
      "candidate.status",
      "candidate.resolved_session_id",
      "candidate.resolved_at",
      "candidate.created_at",
      "candidate.updated_at",
      "session.plate_number as resolved_plate"
    )
    .where("candidate.org_id", orgId)
    .orderBy("candidate.updated_at", "desc")
    .orderBy("candidate.id", "desc")
    .first();
}

async function getLatestEntrySession(orgId: number): Promise<EntrySessionDisplayRow | undefined> {
  return db<EntrySessionDisplayRow>("tb_parking_sessions")
    .select("id", "plate_number", "created_at")
    .where("org_id", orgId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .first();
}

async function entryCandidateStatus(
  orgId: number,
  candidate: EntryCandidateDisplayRow,
  now: Date
): Promise<PublicEntryDisplayStatus> {
  const eventAt = asDate(candidate.updated_at) ?? asDate(candidate.created_at) ?? now;
  const plate = candidate.resolved_plate ?? candidate.detected_plate;
  if (candidate.status === "pending") {
    return isWithinWindow(eventAt, now, PENDING_WINDOW_MS)
      ? { state: "awaiting_operator", plate, barrier_status: null, updated_at: eventAt.toISOString() }
      : idleEntryStatus(now);
  }
  if (candidate.status === "expired") return idleEntryStatus(now);
  if (candidate.status === "declined") {
    return isWithinWindow(eventAt, now, COMPLETED_WINDOW_MS)
      ? { state: "declined", plate, barrier_status: null, updated_at: eventAt.toISOString() }
      : idleEntryStatus(now);
  }
  if (!candidate.resolved_session_id) return idleEntryStatus(now);
  const barrier = await getLatestBarrierAudit(
    orgId,
    "session",
    candidate.resolved_session_id,
    ENTRY_BARRIER_ACTIONS
  );
  const updatedAt = latestDate(eventAt, barrier.createdAt) ?? eventAt;
  const state = publicDisplayStateForBarrier(barrier.status);
  if (state === "barrier_failed") {
    return { state, plate, barrier_status: barrier.status, updated_at: updatedAt.toISOString() };
  }
  return isWithinWindow(updatedAt, now, COMPLETED_WINDOW_MS)
    ? { state, plate, barrier_status: barrier.status, updated_at: updatedAt.toISOString() }
    : idleEntryStatus(now);
}

async function entrySessionStatus(
  orgId: number,
  session: EntrySessionDisplayRow,
  now: Date
): Promise<PublicEntryDisplayStatus> {
  const eventAt = asDate(session.created_at) ?? now;
  const barrier = await getLatestBarrierAudit(orgId, "session", session.id, ENTRY_BARRIER_ACTIONS);
  const updatedAt = latestDate(eventAt, barrier.createdAt) ?? eventAt;
  const state = publicDisplayStateForBarrier(barrier.status);
  if (state === "barrier_failed") {
    return {
      state,
      plate: session.plate_number,
      barrier_status: barrier.status,
      updated_at: updatedAt.toISOString(),
    };
  }
  return isWithinWindow(updatedAt, now, COMPLETED_WINDOW_MS)
    ? {
        state,
        plate: session.plate_number,
        barrier_status: barrier.status,
        updated_at: updatedAt.toISOString(),
      }
    : idleEntryStatus(now);
}

async function getLatestExitCandidate(orgId: number): Promise<ExitCandidateDisplayRow | undefined> {
  return db({ candidate: "tb_exit_candidates" })
    .leftJoin({ matched: "tb_parking_sessions" }, "matched.id", "candidate.matched_session_id")
    .leftJoin({ resolved: "tb_parking_sessions" }, "resolved.id", "candidate.resolved_session_id")
    .select(
      "candidate.id",
      "candidate.detected_plate",
      "candidate.status",
      "candidate.resolution_type",
      "candidate.matched_session_id",
      "candidate.resolved_session_id",
      "candidate.resolved_at",
      "candidate.created_at",
      "candidate.updated_at",
      "matched.plate_number as matched_plate",
      "matched.session_source as matched_source",
      "resolved.plate_number as resolved_plate",
      "resolved.session_source as resolved_source",
      "resolved.amount as resolved_amount",
      "resolved.payment_method as resolved_payment_method",
      "resolved.duration_minutes as resolved_duration_minutes"
    )
    .where("candidate.org_id", orgId)
    .orderBy("candidate.updated_at", "desc")
    .orderBy("candidate.id", "desc")
    .first();
}

async function getLatestCompletedSession(orgId: number): Promise<CompletedSessionDisplayRow | undefined> {
  return db<CompletedSessionDisplayRow>("tb_parking_sessions")
    .select(
      "id",
      "plate_number",
      "session_source",
      "amount",
      "payment_method",
      "duration_minutes",
      "exited_at"
    )
    .where("org_id", orgId)
    .andWhere("status", "completed")
    .whereNotNull("exited_at")
    .orderBy("exited_at", "desc")
    .orderBy("id", "desc")
    .first();
}

async function exitCandidateStatus(
  orgId: number,
  candidate: ExitCandidateDisplayRow,
  now: Date
): Promise<PublicExitDisplayStatus> {
  const eventAt = asDate(candidate.updated_at) ?? asDate(candidate.created_at) ?? now;
  const plate = candidate.resolved_plate ?? candidate.matched_plate ?? candidate.detected_plate;
  const source = candidate.resolved_source ?? candidate.matched_source;
  if (candidate.status === "pending") {
    return isWithinWindow(eventAt, now, PENDING_WINDOW_MS)
      ? {
          state: "awaiting_operator",
          plate,
          session_source: source,
          amount: null,
          payment_method: null,
          duration_minutes: null,
          barrier_status: null,
          updated_at: eventAt.toISOString(),
        }
      : idleExitStatus(now);
  }
  if (candidate.status === "expired") return idleExitStatus(now);
  const barrier = await getLatestBarrierAudit(orgId, "exit_candidate", candidate.id, EXIT_BARRIER_ACTIONS);
  const updatedAt = latestDate(eventAt, barrier.createdAt) ?? eventAt;
  if (candidate.status === "dismissed" && barrier.status === null) {
    return isWithinWindow(updatedAt, now, COMPLETED_WINDOW_MS)
      ? {
          state: "declined",
          plate,
          session_source: null,
          amount: null,
          payment_method: null,
          duration_minutes: null,
          barrier_status: null,
          updated_at: updatedAt.toISOString(),
        }
      : idleExitStatus(now);
  }
  const state = publicDisplayStateForBarrier(barrier.status);
  if (state === "barrier_failed") {
    return {
      state,
      plate,
      session_source: source,
      amount: candidate.status === "accepted" ? numberOrNull(candidate.resolved_amount) : null,
      payment_method:
        candidate.status === "accepted" && source === "regular" ? candidate.resolved_payment_method : null,
      duration_minutes: candidate.status === "accepted" ? candidate.resolved_duration_minutes : null,
      barrier_status: barrier.status,
      updated_at: updatedAt.toISOString(),
    };
  }
  if (candidate.status === "dismissed") {
    return isWithinWindow(updatedAt, now, COMPLETED_WINDOW_MS)
      ? {
          state: "declined",
          plate,
          session_source: null,
          amount: null,
          payment_method: null,
          duration_minutes: null,
          barrier_status: barrier.status,
          updated_at: updatedAt.toISOString(),
        }
      : idleExitStatus(now);
  }
  return isWithinWindow(updatedAt, now, COMPLETED_WINDOW_MS)
    ? {
        state,
        plate,
        session_source: source,
        amount: numberOrNull(candidate.resolved_amount),
        payment_method: source === "regular" ? candidate.resolved_payment_method : null,
        duration_minutes: candidate.resolved_duration_minutes,
        barrier_status: barrier.status,
        updated_at: updatedAt.toISOString(),
      }
    : idleExitStatus(now);
}

function completedSessionStatus(
  session: CompletedSessionDisplayRow,
  now: Date
): PublicExitDisplayStatus {
  const eventAt = asDate(session.exited_at) ?? now;
  return {
    state: publicDisplayStateForBarrier(null),
    plate: session.plate_number,
    session_source: session.session_source,
    amount: numberOrNull(session.amount),
    payment_method: session.session_source === "regular" ? session.payment_method : null,
    duration_minutes: session.duration_minutes,
    barrier_status: null,
    updated_at: eventAt.toISOString(),
  };
}

export async function getDisplayStatus(orgId: number) {
  const organization = await db("tb_organizations")
    .select("name", "pricing_mode", "total_capacity")
    .where({ id: orgId })
    .first();

  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }

  const [{ count }] = await applyInsideSessionsFilter(
    db("tb_parking_sessions").where({ org_id: orgId })
  ).count<{ count: string }[]>("id as count");

  const occupied = Number(count);
  const total: number | null = organization.total_capacity ?? null;

  const status: Record<string, unknown> = {
    orgName: organization.name,
    pricingMode: organization.pricing_mode,
    capacity: {
      occupied,
      total,
      available: total === null ? null : Math.max(0, total - occupied),
    },
  };

  if (organization.pricing_mode === "interval") {
    const intervals = await db("tb_tariff_intervals")
      .select("from_minutes", "to_minutes", "price")
      .where({ org_id: orgId })
      .orderBy("from_minutes", "asc");

    status.intervalTariffs = intervals.map((interval) => ({
      fromMinutes: interval.from_minutes,
      toMinutes: interval.to_minutes,
      price: Number(interval.price),
    }));
  } else {
    const tariff = await db("tb_tariffs").select("price_per_hour", "grace_period_minutes").where({ org_id: orgId }).first();

    if (tariff) {
      status.hourlyTariff = {
        price: Number(tariff.price_per_hour),
        gracePeriodMinutes: tariff.grace_period_minutes,
      };
    }
  }

  return status;
}

export async function getEntryDisplayStatus(orgId: number, now = new Date()): Promise<PublicEntryDisplayStatus> {
  await assertPublicOrganization(orgId);
  const [candidate, session] = await Promise.all([
    getLatestEntryCandidate(orgId),
    getLatestEntrySession(orgId),
  ]);
  const candidateAt = candidate ? asDate(candidate.updated_at) : null;
  const sessionAt = session ? asDate(session.created_at) : null;
  if (candidate && (!sessionAt || (candidateAt?.getTime() ?? 0) >= sessionAt.getTime())) {
    return entryCandidateStatus(orgId, candidate, now);
  }
  return session ? entrySessionStatus(orgId, session, now) : idleEntryStatus(now);
}

export async function getExitDisplayStatus(orgId: number, now = new Date()): Promise<PublicExitDisplayStatus> {
  await assertPublicOrganization(orgId);
  const [candidate, session] = await Promise.all([
    getLatestExitCandidate(orgId),
    getLatestCompletedSession(orgId),
  ]);
  const candidateAt = candidate ? asDate(candidate.updated_at) : null;
  const sessionAt = session ? asDate(session.exited_at) : null;
  const candidateResolvedLatestSession = Boolean(
    candidate?.resolved_session_id && session && candidate.resolved_session_id === session.id
  );
  if (
    candidate &&
    (candidateResolvedLatestSession || !sessionAt || (candidateAt?.getTime() ?? 0) >= sessionAt.getTime())
  ) {
    return exitCandidateStatus(orgId, candidate, now);
  }
  return session ? completedSessionStatus(session, now) : idleExitStatus(now);
}
