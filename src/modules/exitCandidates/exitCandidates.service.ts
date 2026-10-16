import { promises as fs } from "fs";
import type { Knex } from "knex";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload, getUserById } from "@/modules/auth/auth.service";
import {
  calculateDurationMinutes,
  calculateTariffSnapshotAmount,
  displayPlateNumber,
  getSessionImage,
  TariffIntervalSnapshot,
} from "@/modules/parking/parking.service";
import { INSIDE_SESSION_STATUSES } from "@/modules/parking/sessionStatus";
import { BarrierStatus, openBarrier } from "@/modules/relay/relay.service";
import { getWebhookEventImage } from "@/modules/webhook/webhookEventImage.service";
import { resolveSafeCameraEventTime } from "@/modules/webhook/webhookIdempotency";
import {
  isFuzzyPlateMatch,
  normalizeDetectedPlate,
  NULL_PLATE_COALESCE_WINDOW_MS,
  RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS,
} from "@/modules/webhook/webhookRules";
import { getExitDisplayStatus } from "@/modules/publicDisplay/publicDisplay.service";
import {
  findActiveInpatientVehicleForExit,
  findPendingClinicDiscountForExit,
  getOrgTodayDate,
  getOrgTodayRange,
  markClinicDiscountUsed,
} from "@/modules/medplus/medplus.service";
import { ApiError } from "@/utils/ApiError";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import { ledService } from "@/modules/led/led.service";
import { formatDuration } from "@/modules/printer/printer.service";
import { telegramService } from "@/modules/telegram/telegram.service";
import { paymentTerminalManager } from "@/modules/paymentTerminal/PaymentTerminalManager";
import type { PaymentMethod } from "@/modules/payment/paymentMethod";
import {
  abortActiveCardPaymentInBackground,
  abortCandidateCardPaymentInBackground,
  createPaymentTerminalOperation,
  runCardPaymentInBackground,
} from "@/modules/paymentTerminal/paymentTerminalOperations.service";
import {
  emitCardPaymentStarted,
  emitExitCandidateCreated,
  emitExitCandidateResolved,
  emitExitCompleted,
  emitPublicExitStatusChanged,
  emitRelayFailed,
} from "@/websocket/socketServer";
import { canonicalizePlate, plateDistance, similarityPercent } from "./plateMatch";

type CandidateStatus = "pending" | "accepted" | "dismissed" | "expired";
type ResolutionType =
  | "exact"
  | "reassigned"
  | "dismissed"
  | "forced_open"
  | "emergency_forced_open"
  | "emergency_confirmed"
  | "card_payment_initiated"
  | "exit_cancelled";
type ExitPaymentMethod = Exclude<PaymentMethod, "card"> | "emergency";
type ExitMethod = "auto" | "manual" | "forced" | "auto_closed_on_reentry" | "emergency";
export type ForceOpenReason =
  | "plate_not_found"
  | "camera_misread"
  | "no_session"
  | "technical_issue"
  | "emergency"
  | "other";

interface CandidateRow {
  id: number;
  org_id: number;
  webhook_event_id: number;
  detected_plate: string | null;
  suggested_plate: string | null;
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
  plate_number: string | null;
  entered_at: Date;
  exited_at: Date | null;
  status: "active" | "awaiting_payment" | "completed";
  session_source: "regular" | "subscription" | "vip";
  amount: string | number | null;
  duration_minutes: number | null;
  payment_method: PaymentMethod;
  exit_method: ExitMethod | null;
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: TariffIntervalSnapshot[] | string | null;
  entry_overview_image_path: string | null;
  entry_vehicle_image_path: string | null;
}

interface BarrierAuditDetails {
  orgId: number;
  candidateId: number | null;
  barrierStatus: BarrierStatus;
  retryAttempt: boolean;
  detail: string;
}

function serializeSessionSummary(session: SessionSummary) {
  const {
    tariff_price_per_hour: _tariffPrice,
    tariff_grace_period_minutes: _tariffGrace,
    tariff_intervals_snapshot: _tariffIntervals,
    entry_overview_image_path: _entryOverviewPath,
    entry_vehicle_image_path: _entryVehiclePath,
    ...publicSession
  } = session;
  return {
    ...publicSession,
    plate_number: displayPlateNumber(session.plate_number),
  };
}

const FORCE_OPEN_REASONS = new Set<ForceOpenReason>([
  "plate_not_found",
  "camera_misread",
  "no_session",
  "technical_issue",
  "emergency",
  "other",
]);
const BARRIER_AUDIT_ACTIONS = [
  "parking.exit_candidate_barrier_opened",
  "parking.exit_candidate_barrier_open_failed",
  "parking.exit_candidate_barrier_unavailable",
];
const lastLedCandidatePreviewByOrg = new Map<number, number>();

function showLedPaymentPreview(orgId: number, plateNumber: string, amount: number): void {
  try {
    void ledService.showPayment(orgId, plateNumber, amount).catch((error) => {
      console.error("LED_PAYMENT_FAILED", error);
    });
  } catch (error) {
    console.error("LED_PAYMENT_FAILED", error);
  }
}

function showLedPlatePreview(orgId: number, plateNumber: string): void {
  try {
    void ledService.showPlateOnly(orgId, plateNumber).catch((error) => {
      console.error("LED_PLATE_FAILED", error);
    });
  } catch (error) {
    console.error("LED_PLATE_FAILED", error);
  }
}

function scheduleLedReturnToClock(orgId: number): void {
  try {
    ledService.scheduleReturnToClock(orgId);
  } catch (error) {
    console.error("LED_CLOCK_SCHEDULE_FAILED", error);
  }
}

export function sendTelegramExitNotification(
  orgId: number,
  confirmedByUserId: number | null,
  params: {
    plateNumber: string;
    amount: number | null;
    paymentMethod: PaymentMethod | null;
    imageUrl: string | null;
    durationText?: string;
    durationMinutes?: number;
    exitMethod?: "emergency";
  }
): void {
  try {
    void (async () => {
      const user = confirmedByUserId === null ? null : await getUserById(confirmedByUserId);
      const { durationMinutes, ...notification } = params;
      await telegramService.sendExitNotification(orgId, {
        ...notification,
        ...(notification.durationText === undefined && durationMinutes !== undefined
          ? { durationText: formatDuration(durationMinutes) }
          : {}),
        confirmedByName: user?.name.trim() || "Noma'lum",
      });
    })().catch(() => {
      console.error("TELEGRAM_NOTIFICATION_FAILED");
    });
  } catch {
    console.error("TELEGRAM_NOTIFICATION_FAILED");
  }
}

function sendForceOpenTelegramNotification(
  orgId: number,
  params: {
    plateNumber: string;
    webhookEventId: number;
    resolvedSessionId: number | null;
    resolvedAt: Date;
    confirmedByUserId: number;
    isEmergency: boolean;
  }
): void {
  try {
    void (async () => {
      const [resolvedSession, user] = await Promise.all([
        params.resolvedSessionId
          ? db<{ id: number; org_id: number; entered_at: Date }>("tb_parking_sessions")
              .select("entered_at")
              .where({ id: params.resolvedSessionId, org_id: orgId })
              .first()
          : Promise.resolve(null),
        getUserById(params.confirmedByUserId),
      ]);
      await telegramService.sendExitNotification(orgId, {
        plateNumber: params.plateNumber,
        amount: params.isEmergency ? 0 : null,
        paymentMethod: null,
        ...(params.isEmergency ? { exitMethod: "emergency" as const } : {}),
        imageUrl: `/api/webhook-events/${params.webhookEventId}/images/overview`,
        durationText: resolvedSession
          ? formatDuration(
              calculateDurationMinutes(new Date(resolvedSession.entered_at), params.resolvedAt)
            )
          : "Noma'lum",
        confirmedByName: user?.name.trim() || "Noma'lum",
      });
    })().catch(() => {
      console.error("TELEGRAM_NOTIFICATION_FAILED");
    });
  } catch {
    console.error("TELEGRAM_NOTIFICATION_FAILED");
  }
}

function calculateSessionTariffPreview(session: SessionSummary, at: Date) {
  const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), at);
  return {
    durationMinutes,
    amount: calculateTariffSnapshotAmount(session, durationMinutes),
  };
}

interface CandidateCardOperationRow {
  id: number;
  org_id: number;
  session_id: number | null;
  candidate_id: number | null;
  operator_id: number | null;
  operation_number: string;
  requested_amount_som: string | number;
  approved_amount_som: string | number | null;
  status: string;
}

class StaleCardPaymentError extends Error {
  constructor(
    readonly operation: CandidateCardOperationRow,
    readonly sessionStatus: string,
    readonly candidateStatus: string
  ) {
    super("STALE_CARD_PAYMENT");
  }
}

async function resolveAutomaticCardAmount(
  orgId: number,
  session: SessionSummary,
  amount: number,
  timezone: string | null | undefined,
  executor: Knex
): Promise<number> {
  if (!session.plate_number) return amount;
  const inpatientVehicle = await findActiveInpatientVehicleForExit(
    orgId,
    session.plate_number,
    getOrgTodayDate(timezone),
    executor
  );
  if (inpatientVehicle) return 0;
  const discount = await findPendingClinicDiscountForExit(
    orgId,
    session.plate_number,
    getOrgTodayRange(timezone),
    executor
  );
  if (!discount) return amount;
  return Math.round((amount * (100 - discount.discount_percent)) / 100 * 100) / 100;
}

async function startAutomaticCardPayment(
  orgId: number,
  candidate: Pick<CandidateRow, "id" | "status">,
  session: SessionSummary,
  amount: number
): Promise<void> {
  if (session.session_source !== "regular" || !Number.isFinite(amount) || amount <= 0) return;
  const settings = await db("tb_organizations")
    .select(
      "id",
      "timezone",
      "card_terminal_enabled",
      "card_terminal_ip",
      "card_terminal_port"
    )
    .where({ id: orgId })
    .first();
  if (!settings?.card_terminal_enabled || paymentTerminalManager.isBusy(orgId)) return;
  const payableAmount = await resolveAutomaticCardAmount(
    orgId,
    session,
    amount,
    settings.timezone,
    db
  );
  if (payableAmount <= 0 || paymentTerminalManager.isBusy(orgId)) return;
  let lease;
  try {
    lease = paymentTerminalManager.acquireConfigured({
      id: orgId,
      card_terminal_enabled: Boolean(settings.card_terminal_enabled),
      card_terminal_ip: settings.card_terminal_ip ?? null,
      card_terminal_port: settings.card_terminal_port ?? null,
    });
  } catch {
    return;
  }
  try {
    const operation = await db.transaction(async (trx) => {
      const lockedCandidate = await trx<CandidateRow>("tb_exit_candidates")
        .select("id", "status")
        .where({ id: candidate.id, org_id: orgId })
        .forUpdate()
        .first();
      const lockedSession = await trx<SessionSummary>("tb_parking_sessions")
        .select("id", "status", "session_source")
        .where({ id: session.id, org_id: orgId })
        .forUpdate()
        .first();
      if (
        lockedCandidate?.status !== "pending" ||
        lockedSession?.status !== "active" ||
        lockedSession.session_source !== "regular"
      ) {
        return null;
      }
      const existing = await trx("payment_terminal_operations")
        .select("id")
        .where({ org_id: orgId })
        .andWhere((builder) => {
          builder.where({ candidate_id: candidate.id }).orWhere({ session_id: session.id });
        })
        .first();
      if (existing) return null;
      return createPaymentTerminalOperation(trx, {
        orgId,
        sessionId: session.id,
        candidateId: candidate.id,
        operatorId: null,
        amountSom: payableAmount,
      });
    });
    if (!operation) {
      lease.release();
      return;
    }
    runCardPaymentInBackground(operation.id, operation.operationNumber, lease);
    emitCardPaymentStarted(orgId, {
      sessionId: session.id,
      candidateId: candidate.id,
      operationNumber: operation.operationNumber,
      plateNumber: displayPlateNumber(session.plate_number),
    });
  } catch (error) {
    lease.release();
    console.error(
      `CARD_PAYMENT_AUTO_START_FAILED org_id=${orgId} candidate_id=${candidate.id}`,
      error
    );
  }
}

export async function tryAutoStartCardPayment(
  orgId: number,
  candidate: Pick<CandidateRow, "id" | "status">,
  session: SessionSummary,
  amount: number
): Promise<void> {
  try {
    await startAutomaticCardPayment(orgId, candidate, session, amount);
  } catch (error) {
    console.error(
      `CARD_PAYMENT_AUTO_START_FAILED org_id=${orgId} candidate_id=${candidate.id}`,
      error
    );
  }
}

function eventImageUrl(eventId: number, kind: "overview" | "vehicle" | "plate", imagePath?: string | null) {
  return imagePath ? `/api/webhook-events/${eventId}/images/${kind}` : null;
}

function sessionImageUrl(sessionId: number, kind: "entry-overview" | "entry-vehicle", imagePath?: string | null) {
  return imagePath ? `/api/parking/sessions/${sessionId}/images/${kind}` : null;
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
    overviewImageUrl: eventImageUrl(candidate.webhook_event_id, "overview", overviewPath),
    vehicleImageUrl: eventImageUrl(candidate.webhook_event_id, "vehicle", vehiclePath),
    plateImageUrl: eventImageUrl(candidate.webhook_event_id, "plate", platePath),
    matched_session: session ? serializeSessionSummary(session) : null,
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

function sessionSummaryQuery(executor = db) {
  return executor<SessionSummary>("tb_parking_sessions").select(
    "id",
    "org_id",
    "plate_number",
    "entered_at",
    "exited_at",
    "status",
    "session_source",
    "amount",
    "duration_minutes",
    "payment_method",
    "exit_method",
    "tariff_price_per_hour",
    "tariff_grace_period_minutes",
    "tariff_intervals_snapshot",
    "entry_overview_image_path",
    "entry_vehicle_image_path"
  );
}

async function loadSessionSummaries(ids: number[], orgId?: number): Promise<Map<number, SessionSummary>> {
  if (ids.length === 0) return new Map();
  const query = sessionSummaryQuery().whereIn("id", ids);
  if (orgId !== undefined) query.andWhere({ org_id: orgId });
  const rows = await query;
  return new Map(rows.map((row) => [row.id, row]));
}

async function getCandidateByInternalId(orgId: number, id: number) {
  const candidate = await candidateWithImagesQuery()
    .where({ "tb_exit_candidates.id": id, "tb_exit_candidates.org_id": orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  const sessions = await loadSessionSummaries(
    candidate.matched_session_id ? [candidate.matched_session_id] : [],
    orgId
  );
  return serializeCandidate(
    candidate,
    candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null
  );
}

async function accessibleEventImageUrl(
  actor: AuthTokenPayload,
  eventId: number,
  kind: "overview" | "vehicle",
  imagePath: string | null | undefined
): Promise<string | null> {
  if (!imagePath) return null;
  try {
    await getWebhookEventImage(actor, eventId, kind);
    return eventImageUrl(eventId, kind, imagePath);
  } catch {
    return null;
  }
}

async function accessibleSessionImageUrl(
  actor: AuthTokenPayload,
  sessionId: number,
  kind: "entry-overview" | "entry-vehicle",
  imagePath: string | null | undefined
): Promise<string | null> {
  if (!imagePath) return null;
  try {
    const absolutePath = await getSessionImage(actor, sessionId, kind);
    await fs.access(absolutePath);
    return sessionImageUrl(sessionId, kind, imagePath);
  } catch {
    return null;
  }
}

async function exitImages(actor: AuthTokenPayload, candidate: CandidateRow) {
  const overviewUrl = await accessibleEventImageUrl(
    actor,
    candidate.webhook_event_id,
    "overview",
    candidate.overview_image_path
  );
  const vehicleUrl = overviewUrl
    ? null
    : await accessibleEventImageUrl(
        actor,
        candidate.webhook_event_id,
        "vehicle",
        candidate.vehicle_image_path
      );
  return { overview_url: overviewUrl, vehicle_url: vehicleUrl, image_available: !!(overviewUrl || vehicleUrl) };
}

async function entryImages(actor: AuthTokenPayload, session: SessionSummary) {
  const overviewUrl = await accessibleSessionImageUrl(
    actor,
    session.id,
    "entry-overview",
    session.entry_overview_image_path
  );
  const vehicleUrl = overviewUrl
    ? null
    : await accessibleSessionImageUrl(
        actor,
        session.id,
        "entry-vehicle",
        session.entry_vehicle_image_path
      );
  return { overview_url: overviewUrl, vehicle_url: vehicleUrl, image_available: !!(overviewUrl || vehicleUrl) };
}

function normalizePlate(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function findFuzzyActiveSession(trx: Knex.Transaction, orgId: number, detectedPlate: string) {
  const sessions = await trx<SessionSummary>("tb_parking_sessions")
    .select("id", "status", "plate_number")
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number");
  const matches = sessions.filter((session) => isFuzzyPlateMatch(detectedPlate, session.plate_number));
  return matches.length === 1 ? matches[0] : undefined;
}

async function findV2ActiveSession(
  trx: Knex.Transaction,
  orgId: number,
  detectedPlate: string,
  cameraEventAt: Date
) {
  const canonicalDetectedPlate = canonicalizePlate(detectedPlate);
  if (canonicalDetectedPlate.length < 3) return undefined;
  const sessions = await trx<SessionSummary>("tb_parking_sessions")
    .select("id", "status", "plate_number")
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number")
    .andWhere("entered_at", "<", cameraEventAt);
  const matchesAtDistance = (distance: number) =>
    sessions.filter(
      (session) =>
        canonicalizePlate(session.plate_number ?? "").length >= 3 &&
        plateDistance(canonicalDetectedPlate, session.plate_number ?? "") === distance
    );
  const canonicalMatches = matchesAtDistance(0);
  if (canonicalMatches.length > 0) {
    return canonicalMatches.length === 1 ? canonicalMatches[0] : undefined;
  }
  const distanceOneMatches = matchesAtDistance(1);
  return distanceOneMatches.length === 1 ? distanceOneMatches[0] : undefined;
}

async function findRecentlyResolvedCandidate(
  trx: Knex.Transaction,
  orgId: number,
  detectedPlate: string
) {
  const now = Date.now();
  const cancelledCooldownMs = env.cancelledExitCooldownSeconds * 1000;
  const queryCooldownMs = Math.max(RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS, cancelledCooldownMs);
  const candidates = await trx<CandidateRow>("tb_exit_candidates")
    .select("id", "detected_plate", "resolved_session_id", "resolution_type", "resolved_at")
    .where({ org_id: orgId })
    .whereIn("status", ["accepted", "dismissed"])
    .whereNotNull("resolved_at")
    .andWhere("resolved_at", ">=", new Date(now - queryCooldownMs))
    .orderBy("resolved_at", "desc");
  const recentCandidates = candidates.filter((candidate) => {
    if (!candidate.resolved_at) return false;
    const cooldownMs =
      candidate.resolution_type === "exit_cancelled"
        ? cancelledCooldownMs
        : RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS;
    return new Date(candidate.resolved_at).getTime() >= now - cooldownMs;
  });
  const exact = recentCandidates.find((candidate) => candidate.detected_plate === detectedPlate);
  if (exact) return exact;
  const fuzzyMatches = recentCandidates.filter((candidate) =>
    isFuzzyPlateMatch(detectedPlate, candidate.detected_plate)
  );
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] : undefined;
}

async function findFuzzyPendingCandidate(
  trx: Knex.Transaction,
  orgId: number,
  detectedPlate: string
) {
  const candidates = await trx<CandidateRow>("tb_exit_candidates")
    .where({ org_id: orgId, status: "pending" })
    .whereNotNull("detected_plate")
    .orderBy("camera_event_at", "desc")
    .forUpdate();
  const matches = candidates.filter((candidate) =>
    isFuzzyPlateMatch(detectedPlate, candidate.detected_plate)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

interface RecoverableFreeExitSession {
  id: number;
  entered_at: Date;
  exited_at: Date;
}

async function recoverFreeExitSession(
  trx: Knex.Transaction,
  orgId: number,
  plateNumber: string
): Promise<{ id: number; status: "active" } | undefined> {
  if (!env.freeExitRecovery.enabled) return undefined;
  try {
    return await trx.transaction(async (savepoint) => {
      const recoveryStart = new Date(Date.now() - env.freeExitRecovery.hours * 60 * 60_000);
      const session = await savepoint<RecoverableFreeExitSession>("tb_parking_sessions as recovered")
        .select("recovered.id", "recovered.entered_at", "recovered.exited_at")
        .where("recovered.org_id", orgId)
        .andWhere("recovered.plate_number", plateNumber)
        .andWhere("recovered.status", "completed")
        .andWhere("recovered.session_source", "regular")
        .andWhere("recovered.exit_method", "auto")
        .andWhere("recovered.amount", 0)
        .andWhere("recovered.exited_at", ">=", recoveryStart)
        .whereNotExists(
          savepoint("tb_payments as payment")
            .select(savepoint.raw("1"))
            .whereRaw("payment.session_id = recovered.id")
        )
        .whereNotExists(
          savepoint("payment_terminal_operations as operation")
            .select(savepoint.raw("1"))
            .whereRaw("operation.session_id = recovered.id")
            .whereIn("operation.status", ["APPROVED", "FIN_FAILED", "ORPHANED"])
        )
        .whereNotExists(
          savepoint("tb_parking_sessions as later")
            .select(savepoint.raw("1"))
            .whereRaw("later.org_id = recovered.org_id")
            .whereRaw("later.plate_number = recovered.plate_number")
            .whereRaw("later.entered_at > recovered.entered_at")
        )
        .orderBy("recovered.exited_at", "desc")
        .orderBy("recovered.id", "desc")
        .forUpdate()
        .first();
      if (!session) return undefined;
      const updated = await savepoint("tb_parking_sessions")
        .where({
          id: session.id,
          org_id: orgId,
          plate_number: plateNumber,
          status: "completed",
          session_source: "regular",
          exit_method: "auto",
          amount: 0,
        })
        .update({
          status: "active",
          exited_at: null,
          duration_minutes: null,
          amount: null,
          exit_method: null,
          image_exit: null,
          exit_overview_image_path: null,
          exit_vehicle_image_path: null,
          exit_plate_image_path: null,
          active_plate_key: `${orgId}:${plateNumber}`,
        });
      if (!updated) return undefined;
      await savepoint("tb_activity_logs").insert({
        actor_id: null,
        action: "session.reopened_for_exit",
        target_type: "session",
        target_id: session.id,
        details: JSON.stringify({
          orgId,
          sessionId: session.id,
          oldExitedAt: new Date(session.exited_at).toISOString(),
        }),
      });
      return { id: session.id, status: "active" as const };
    });
  } catch (error) {
    console.error(
      `FREE_EXIT_RECOVERY_FAILED org_id=${orgId} plate=${plateNumber}`,
      error
    );
    return undefined;
  }
}

function canonicalPlate(value: string): string {
  const mapping: Record<string, string> = { O: "0", I: "1", B: "8", S: "5", Z: "2", G: "6" };
  return [...value].map((char) => mapping[char] ?? char).join("");
}

function damerauLevenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[left.length][right.length];
}

function similarityScore(input: string, candidate: string): number | null {
  const normalizedInput = normalizePlate(input);
  const normalizedCandidate = normalizePlate(candidate);
  if (!normalizedInput || !normalizedCandidate) return null;
  if (normalizedInput === normalizedCandidate) return 100;
  const canonicalInput = canonicalPlate(normalizedInput);
  const canonicalCandidate = canonicalPlate(normalizedCandidate);
  if (canonicalInput === canonicalCandidate) return 98;
  const distance = Math.min(
    damerauLevenshtein(normalizedInput, normalizedCandidate),
    damerauLevenshtein(canonicalInput, canonicalCandidate)
  );
  if (distance > 2) return null;
  const length = Math.max(normalizedInput.length, normalizedCandidate.length, 1);
  return Math.round((1 - distance / length) * 10000) / 100;
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

export async function recordBarrierAttempt(input: {
  actorId: number | null;
  orgId: number;
  candidateId: number | null;
  sessionId?: number;
  retryAttempt: boolean;
}): Promise<BarrierStatus> {
  let status: BarrierStatus;
  let detail: string;
  try {
    const result = await openBarrier(input.orgId, "exit");
    status = result.status;
    detail = result.detail ?? result.status;
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
  }
  const action =
    status === "opened"
      ? "parking.exit_candidate_barrier_opened"
      : status === "failed"
        ? "parking.exit_candidate_barrier_open_failed"
        : "parking.exit_candidate_barrier_unavailable";
  const details: BarrierAuditDetails = {
    orgId: input.orgId,
    candidateId: input.candidateId,
    barrierStatus: status,
    retryAttempt: input.retryAttempt,
    detail,
  };
  await db("tb_activity_logs").insert({
    actor_id: input.actorId,
    action,
    target_type: input.candidateId === null ? "session" : "exit_candidate",
    target_id: input.candidateId ?? input.sessionId!,
    details: JSON.stringify({ ...details, sessionId: input.sessionId ?? null }),
  });
  return status;
}

function autoStartCardPaymentForCandidate(
  orgId: number,
  candidate: Pick<CandidateRow, "id" | "status">,
  sessionId: number
): void {
  setImmediate(() => {
    void (async () => {
      const session = await sessionSummaryQuery()
        .where({ id: sessionId, org_id: orgId, status: "active" })
        .first();
      if (!session) return;
      const preview = calculateSessionTariffPreview(session, new Date());
      await tryAutoStartCardPayment(orgId, candidate, session, preview.amount ?? 0);
    })().catch((error) => {
      console.error(
        `CARD_PAYMENT_CANDIDATE_TRIGGER_FAILED org_id=${orgId} candidate_id=${candidate.id}`,
        error
      );
    });
  });
}

export async function createExitCandidate(input: {
  orgId: number;
  webhookEventId: number;
  detectedPlate: string | null;
  suggestedPlate?: string | null;
  confidence: number | null;
}) {
  const detectedPlate = normalizeDetectedPlate(input.detectedPlate);
  const suggestedPlate = normalizeDetectedPlate(input.suggestedPlate);
  const result = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();
    const existingByEvent = await trx<CandidateRow>("tb_exit_candidates")
      .where({ webhook_event_id: input.webhookEventId, org_id: input.orgId })
      .first();
    if (existingByEvent) {
      return {
        candidateId: existingByEvent.id,
        matchedSessionId: existingByEvent.matched_session_id,
        created: false,
        coalesced: false,
        skipped: false as const,
      };
    }
    const webhookEvent = await trx("tb_webhook_events")
      .select("camera_event_at", "created_at")
      .where({ id: input.webhookEventId, org_id: input.orgId, direction: "exit" })
      .first();
    if (!webhookEvent) throw new ApiError("Webhook exit hodisasi topilmadi", 404);
    const cameraEventAt = resolveSafeCameraEventTime(webhookEvent.camera_event_at, webhookEvent.created_at);
    let matchingSession = detectedPlate
      ? await trx<SessionSummary>("tb_parking_sessions")
          .select("id", "status")
          .where({ org_id: input.orgId, plate_number: detectedPlate })
          .whereIn("status", [...INSIDE_SESSION_STATUSES])
          .orderByRaw("CASE WHEN status = 'active' THEN 0 ELSE 1 END")
          .orderBy("entered_at", "desc")
          .orderBy("id", "desc")
          .first()
      : undefined;
    if (detectedPlate && !matchingSession) {
      matchingSession = env.exitMatchV2Enabled
        ? await findV2ActiveSession(trx, input.orgId, detectedPlate, cameraEventAt)
        : await findFuzzyActiveSession(trx, input.orgId, detectedPlate);
    }
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
    if (detectedPlate && !matchingSession) {
      matchingSession = await recoverFreeExitSession(trx, input.orgId, detectedPlate);
    }
    const matchedSession = matchingSession?.status === "active" ? matchingSession : null;
    if (detectedPlate && !matchedSession) {
      const resolvedCandidate = await findRecentlyResolvedCandidate(trx, input.orgId, detectedPlate);
      if (resolvedCandidate) {
        await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
          processing_result: "resolved_recently_ignored",
          processing_reason: "resolved_candidate_cooldown",
          session_id: resolvedCandidate.resolved_session_id,
          processed_at: trx.fn.now(),
        });
        return {
          skipped: true as const,
          reason: "resolved_recently_ignored" as const,
          sessionId: resolvedCandidate.resolved_session_id ?? undefined,
        };
      }
    }
    let pendingQuery = trx<CandidateRow>("tb_exit_candidates").where({
      org_id: input.orgId,
      status: "pending",
    });
    if (detectedPlate) {
      pendingQuery = pendingQuery.andWhere({ detected_plate: detectedPlate });
    } else if (!suggestedPlate) {
      pendingQuery = pendingQuery
        .whereNull("detected_plate")
        .whereNull("suggested_plate")
        .andWhere(
          "camera_event_at",
          ">=",
          new Date(cameraEventAt.getTime() - NULL_PLATE_COALESCE_WINDOW_MS)
        )
        .andWhere(
          "camera_event_at",
          "<=",
          new Date(cameraEventAt.getTime() + NULL_PLATE_COALESCE_WINDOW_MS)
        );
    }
    let pending: CandidateRow | undefined;
    if (suggestedPlate) {
      const candidates = await pendingQuery
        .whereNull("detected_plate")
        .whereNotNull("suggested_plate")
        .andWhere(
          "camera_event_at",
          ">=",
          new Date(cameraEventAt.getTime() - NULL_PLATE_COALESCE_WINDOW_MS)
        )
        .andWhere(
          "camera_event_at",
          "<=",
          new Date(cameraEventAt.getTime() + NULL_PLATE_COALESCE_WINDOW_MS)
        )
        .orderBy("camera_event_at", "desc")
        .forUpdate();
      const matches = candidates.filter(
        (candidate) =>
          candidate.suggested_plate === suggestedPlate ||
          isFuzzyPlateMatch(suggestedPlate, candidate.suggested_plate)
      );
      pending = matches.length === 1 ? matches[0] : undefined;
    } else {
      pending = await pendingQuery.orderBy("camera_event_at", "desc").forUpdate().first();
    }
    if (!pending && detectedPlate) {
      pending = await findFuzzyPendingCandidate(trx, input.orgId, detectedPlate);
    }
    if (pending) {
      await trx("tb_exit_candidates").where({ id: pending.id, org_id: input.orgId }).update({
        camera_event_at: cameraEventAt,
        confidence: input.confidence,
        suggested_plate: suggestedPlate,
        updated_at: trx.fn.now(),
      });
      await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
        processing_result: "exit_candidate_coalesced",
        processing_reason: "pending_candidate_exists",
        session_id: matchedSession?.id ?? pending.matched_session_id ?? null,
      });
      return {
        candidateId: pending.id,
        matchedSessionId: matchedSession?.id ?? pending.matched_session_id,
        created: false,
        coalesced: true,
        skipped: false as const,
      };
    }
    const [candidateId] = await trx("tb_exit_candidates").insert({
      org_id: input.orgId,
      webhook_event_id: input.webhookEventId,
      detected_plate: detectedPlate,
      suggested_plate: suggestedPlate,
      matched_session_id: matchedSession?.id ?? null,
      confidence: input.confidence,
      camera_event_at: cameraEventAt,
    });
    await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
      processing_result: "exit_candidate_pending",
      processing_reason: matchedSession
        ? "exact_inside_session_found"
        : detectedPlate
          ? "inside_session_not_found"
          : "camera_ocr_failed",
      session_id: matchedSession?.id ?? null,
    });
    await trx("tb_activity_logs").insert({
      actor_id: null,
      action: "parking.exit_candidate_created",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        orgId: input.orgId,
        candidateId,
        detectedPlate,
        matchedSessionId: matchedSession?.id ?? null,
        webhookEventId: input.webhookEventId,
        confidence: input.confidence,
      }),
    });
    return {
      candidateId,
      matchedSessionId: matchedSession?.id ?? null,
      created: true,
      coalesced: false,
      skipped: false as const,
    };
  });
  if (result.skipped) return result;
  const candidate = await getCandidateByInternalId(input.orgId, result.candidateId);
  let autoCardEligible = !!result.matchedSessionId;
  if (env.exitMatchV2Enabled && result.matchedSessionId) {
    const matchedSession = await db<SessionSummary>("tb_parking_sessions")
      .select("plate_number")
      .where({ id: result.matchedSessionId, org_id: input.orgId })
      .first();
    autoCardEligible =
      !!candidate.detected_plate &&
      !!matchedSession?.plate_number &&
      plateDistance(candidate.detected_plate, matchedSession.plate_number) === 0;
  }
  if (result.matchedSessionId && autoCardEligible) {
    autoStartCardPaymentForCandidate(input.orgId, candidate, result.matchedSessionId);
  }
  if (result.created) {
    emitExitCandidateCreated(input.orgId, {
      candidateId: candidate.id,
      orgId: input.orgId,
      webhookEventId: candidate.webhook_event_id,
      detectedPlate: candidate.detected_plate,
      suggestedPlate: candidate.suggested_plate,
      matchedSessionId: candidate.matched_session_id,
      confidence: candidate.confidence,
      cameraEventAt: new Date(candidate.camera_event_at).toISOString(),
      status: "pending",
      exitImages: {
        overviewUrl: candidate.overviewImageUrl,
        vehicleUrl: candidate.vehicleImageUrl,
        plateUrl: candidate.plateImageUrl,
      },
    });
  }
  const ledPlateNumber = candidate.detected_plate ?? candidate.suggested_plate;
  if (ledPlateNumber) showLedPlatePreview(input.orgId, displayPlateNumber(ledPlateNumber));
  return { ...result, candidate };
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
  const sessionIds = candidates.flatMap((candidate) =>
    candidate.matched_session_id ? [candidate.matched_session_id] : []
  );
  const sessions = await loadSessionSummaries(sessionIds, orgId);
  return {
    candidates: candidates.map((candidate) =>
      serializeCandidate(
        candidate,
        candidate.matched_session_id ? sessions.get(candidate.matched_session_id) ?? null : null
      )
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
  const suggestions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .orderBy("entered_at", "desc")
    .orderBy("id", "desc")
    .limit(100);
  return { candidate, suggestions: suggestions.map(serializeSessionSummary) };
}

export async function getNextExitCandidate(actor: AuthTokenPayload, requestedOrgId: number | undefined) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const [{ count }] = await db("tb_exit_candidates")
    .where({ org_id: orgId, status: "pending" })
    .count<{ count: string }[]>("id as count");
  const candidate = await candidateWithImagesQuery()
    .where({ "tb_exit_candidates.org_id": orgId, "tb_exit_candidates.status": "pending" })
    .orderBy("tb_exit_candidates.created_at", "asc")
    .orderBy("tb_exit_candidates.id", "asc")
    .first();
  if (!candidate) {
    lastLedCandidatePreviewByOrg.delete(orgId);
    return { candidate: null, pending_count_for_org: 0 };
  }
  const session = candidate.detected_plate
    ? await sessionSummaryQuery()
        .where({ org_id: orgId, status: "active", plate_number: candidate.detected_plate })
        .orderBy("entered_at", "desc")
        .orderBy("id", "desc")
        .first()
    : null;
  let matchedSession = null;
  if (session) {
    const preview = calculateSessionTariffPreview(session, new Date());
    if (
      preview.amount !== null &&
      lastLedCandidatePreviewByOrg.get(orgId) !== candidate.id
    ) {
      lastLedCandidatePreviewByOrg.set(orgId, candidate.id);
      showLedPaymentPreview(orgId, displayPlateNumber(session.plate_number), preview.amount);
    }
    await tryAutoStartCardPayment(orgId, candidate, session, preview.amount ?? 0);
    matchedSession = {
      session_id: session.id,
      plate_number: session.plate_number,
      session_source: session.session_source,
      entered_at: session.entered_at,
      entry_images: await entryImages(actor, session),
      duration_minutes: preview.durationMinutes,
      tariff_snapshot_amount: preview.amount,
    };
  }
  return {
    candidate_id: candidate.id,
    status: candidate.status,
    webhook_event_id: candidate.webhook_event_id,
    detected_plate: candidate.detected_plate,
    suggested_plate: candidate.suggested_plate,
    camera_event_at: candidate.camera_event_at,
    exit_images: await exitImages(actor, candidate),
    matched_session: matchedSession,
    pending_count_for_org: Number(count),
  };
}

export async function searchExitCandidateSessions(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  plate?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const candidate = await db<CandidateRow>("tb_exit_candidates")
    .where({ id: candidateId, org_id: orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
  const now = new Date();
  const activeSessions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .orderBy("entered_at", "desc")
    .orderBy("id", "desc")
    .limit(30);
  const active_sessions = await Promise.all(
    activeSessions.map(async (session) => {
      const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
      return {
        session_id: String(session.id),
        plate_number: displayPlateNumber(session.plate_number),
        entered_at: new Date(session.entered_at).toISOString(),
        session_source: session.session_source,
        duration_minutes: durationMinutes,
        tariff_snapshot_amount: calculateTariffSnapshotAmount(session, durationMinutes) ?? 0,
        entry_images: await entryImages(actor, session),
      };
    })
  );
  if (env.exitMatchV2Enabled) {
    const searchPlate = plate !== undefined
      ? normalizePlate(plate)
      : candidate.detected_plate ?? candidate.suggested_plate ?? "";
    if (canonicalizePlate(searchPlate).length < 3) return { results: [], active_sessions };
    const sessions = await sessionSummaryQuery()
      .where({ org_id: orgId, status: "active" })
      .whereNotNull("plate_number");
    const scored = sessions
      .map((session) => {
        const distance = plateDistance(searchPlate, session.plate_number ?? "");
        return {
          session,
          distance,
          score: similarityPercent(searchPlate, session.plate_number ?? ""),
        };
      })
      .filter(
        (item) =>
          canonicalizePlate(item.session.plate_number ?? "").length >= 3 && item.distance <= 2
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          new Date(right.session.entered_at).getTime() - new Date(left.session.entered_at).getTime() ||
          right.session.id - left.session.id
      )
      .slice(0, 10);
    const results = await Promise.all(
      scored.map(async ({ session, score }) => {
        const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
        return {
          session_id: String(session.id),
          plate_number: displayPlateNumber(session.plate_number),
          entered_at: new Date(session.entered_at).toISOString(),
          session_source: session.session_source,
          similarity_score: score,
          similarity: score,
          duration_minutes: durationMinutes,
          tariff_snapshot_amount: calculateTariffSnapshotAmount(session, durationMinutes) ?? 0,
          entry_images: await entryImages(actor, session),
        };
      })
    );
    return { results, active_sessions };
  }
  const normalized = plate ? normalizePlate(plate) : "";
  if (!normalized) return { results: [], active_sessions };
  const sessions = await sessionSummaryQuery()
    .where({ org_id: orgId, status: "active" })
    .whereNotNull("plate_number");
  const scored = sessions
    .map((session) => ({
      session,
      score: session.plate_number === null ? null : similarityScore(normalized, session.plate_number),
    }))
    .filter((item): item is { session: SessionSummary; score: number } => item.score !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        new Date(right.session.entered_at).getTime() - new Date(left.session.entered_at).getTime() ||
        right.session.id - left.session.id
    )
    .slice(0, 10);
  const results = await Promise.all(
    scored.map(async ({ session, score }) => {
      const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
      return {
        session_id: String(session.id),
        plate_number: displayPlateNumber(session.plate_number),
        entered_at: new Date(session.entered_at).toISOString(),
        session_source: session.session_source,
        similarity_score: score,
        duration_minutes: durationMinutes,
        tariff_snapshot_amount: calculateTariffSnapshotAmount(session, durationMinutes) ?? 0,
        entry_images: await entryImages(actor, session),
      };
    })
  );
  return { results, active_sessions };
}

export async function previewExitCandidateSession(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  sessionId: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const result = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .select("id", "status")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const session = await sessionSummaryQuery(trx)
      .where({ id: sessionId, org_id: orgId })
      .whereIn("status", ["active", "awaiting_payment"])
      .forUpdate()
      .first();
    if (!session) throw new ApiError("Tanlangan sessiya topilmadi", 404);
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
      resolved_session_id: session.id,
      updated_at: trx.fn.now(),
    });
    const preview = calculateSessionTariffPreview(session, new Date());
    return {
      amount: preview.amount ?? 0,
      plateNumber: displayPlateNumber(session.plate_number),
    };
  });
  const { amount, plateNumber } = result;
  showLedPaymentPreview(orgId, plateNumber, amount);
  return { plateNumber, amount };
}

export async function completeCardPaymentForCandidate(
  orgId: number,
  operationNumber: string,
  rawFinRequestHex: string,
  rawFinResponseHex: string | null
): Promise<void> {
  let completed;
  try {
    completed = await db.transaction(async (trx) => {
      const operation = await trx<CandidateCardOperationRow>("payment_terminal_operations")
        .where({ org_id: orgId, operation_number: operationNumber })
        .forUpdate()
        .first();
      if (!operation) throw new ApiError("Terminal operatsiyasi topilmadi", 404);
      if (operation.candidate_id === null || operation.session_id === null) {
        throw new ApiError("Terminal operatsiyasi candidate sessiyasiga bog'lanmagan", 409);
      }
      const candidate = await trx<CandidateRow>("tb_exit_candidates")
        .where({ id: operation.candidate_id, org_id: orgId })
        .forUpdate()
        .first();
      const session = await sessionSummaryQuery(trx)
        .where({ id: operation.session_id, org_id: orgId })
        .forUpdate()
        .first();
      if (!candidate || !session) throw new ApiError("Candidate yoki sessiya topilmadi", 404);
      if (candidate.status !== "pending" || session.status !== "active") {
        throw new StaleCardPaymentError(operation, session.status, candidate.status);
      }
      if (operation.status !== "APPROVED") return null;
      const approvedAmount = Number(operation.approved_amount_som);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        throw new ApiError("Terminal tasdiqlagan summa noto'g'ri", 409);
      }
      const resolvedAt = new Date();
      const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), resolvedAt);
      const resolutionType: ResolutionType =
        candidate.matched_session_id === session.id ? "exact" : "reassigned";
      await trx("payment_terminal_operations")
        .where({ id: operation.id, status: "APPROVED" })
        .update({
          status: "FIN_CONFIRMED",
          raw_fin_request_hex: rawFinRequestHex,
          raw_fin_response_hex: rawFinResponseHex,
          error_message: null,
          updated_at: trx.fn.now(),
        });
      await trx("tb_parking_sessions").where({ id: session.id, org_id: orgId }).update({
        status: "completed",
        exited_at: resolvedAt,
        duration_minutes: durationMinutes,
        amount: approvedAmount,
        payment_method: "card",
        exit_method: "auto",
        operator_id: operation.operator_id,
        active_plate_key: null,
      });
      const [paymentId] = await trx("tb_payments").insert({
        org_id: orgId,
        session_id: session.id,
        amount: approvedAmount,
        payment_method: "card",
        paid_at: resolvedAt,
        operator_id: operation.operator_id,
      });
      await trx("tb_exit_candidates").where({ id: candidate.id, org_id: orgId }).update({
        status: "accepted",
        resolution_type: resolutionType,
        resolved_session_id: session.id,
        resolved_by: operation.operator_id,
        resolved_at: resolvedAt,
        updated_at: resolvedAt,
      });
      await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
        processing_result: "exit_completed",
        processing_reason: `candidate_${resolutionType}_confirmed`,
        session_id: session.id,
        processed_at: trx.fn.now(),
      });
      const organization = await trx("tb_organizations")
        .select("timezone")
        .where({ id: orgId })
        .first();
      if (session.plate_number) {
        const discount = await findPendingClinicDiscountForExit(
          orgId,
          session.plate_number,
          getOrgTodayRange(organization?.timezone),
          trx
        );
        if (discount) {
          await markClinicDiscountUsed(discount.id, session.id, resolvedAt, trx);
          await trx("tb_activity_logs").insert({
            actor_id: operation.operator_id,
            action: "clinic_discount_applied",
            target_type: "exit_candidate",
            target_id: candidate.id,
            details: JSON.stringify({
              orgId,
              sessionId: session.id,
              discountId: discount.id,
              discountPercent: discount.discount_percent,
              discountedAmount: approvedAmount,
            }),
          });
        }
      }
      await trx("tb_activity_logs").insert({
        actor_id: operation.operator_id,
        action: resolutionType === "exact" ? "exit_candidate.accepted" : "exit_candidate.reassigned",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId,
          detectedPlate: candidate.detected_plate,
          selectedSessionId: session.id,
          oldStatus: "active",
          newStatus: "completed",
          operatorId: operation.operator_id,
          amount: approvedAmount,
          paymentMethod: "card",
          exitMethod: "auto",
          operationNumber,
        }),
      });
      await trx("tb_activity_logs").insert({
        actor_id: operation.operator_id,
        action: "payment_terminal.card_payment_confirmed",
        target_type: "session",
        target_id: session.id,
        details: JSON.stringify({ orgId, operationNumber, amount: approvedAmount }),
      });
      return {
        operation,
        candidate,
        resolutionType,
        webhookEventId: candidate.webhook_event_id,
        session: {
          ...session,
          status: "completed" as const,
          exited_at: resolvedAt,
          duration_minutes: durationMinutes,
          amount: approvedAmount,
          payment_method: "card" as const,
          exit_method: "auto" as const,
        },
        payment: {
          id: paymentId,
          amount: approvedAmount,
          payment_method: "card" as const,
          paid_at: resolvedAt,
        },
      };
    });
  } catch (error) {
    if (!(error instanceof StaleCardPaymentError)) throw error;
    const updated = await db("payment_terminal_operations")
      .where({ id: error.operation.id })
      .whereIn("status", ["APPROVED", "ABORTED"])
      .update({
        status: "STALE_IGNORED",
        raw_fin_request_hex: rawFinRequestHex,
        raw_fin_response_hex: rawFinResponseHex,
        error_message: "Sessiya allaqachon boshqa usul bilan yopilgan",
        updated_at: db.fn.now(),
      });
    if (updated) {
      await db("tb_activity_logs").insert({
        actor_id: error.operation.operator_id,
        action: "payment_terminal.manual_reconciliation_required",
        target_type: "session",
        target_id: error.operation.session_id,
        details: JSON.stringify({
          orgId,
          operationNumber,
          reason: "stale_card_payment",
          sessionStatus: error.sessionStatus,
          candidateStatus: error.candidateStatus,
        }),
      });
    }
    console.error(
      `STALE CARD PAYMENT: operation=${operationNumber}, session allaqachon boshqa usul bilan yopilgan, pul terminal orqali olingan bo'lishi mumkin — QO'LDA TEKSHIRING`
    );
    return;
  }
  if (!completed) return;
  const plateNumber = displayPlateNumber(completed.session.plate_number);
  void (async () => {
    const user = completed.operation.operator_id
      ? await getUserById(completed.operation.operator_id).catch(() => null)
      : null;
    await telegramService.sendExitNotification(orgId, {
      plateNumber,
      amount: Number(completed.session.amount),
      paymentMethod: "card",
      imageUrl: `/api/webhook-events/${completed.webhookEventId}/images/overview`,
      durationText: formatDuration(completed.session.duration_minutes),
      confirmedByName: user?.name.trim() || "Karta terminali",
    });
  })().catch(() => console.error("TELEGRAM_NOTIFICATION_FAILED"));
  try {
    void ledService.showPayment(orgId, plateNumber, Number(completed.session.amount)).catch((error) => {
      console.error("LED_PAYMENT_FAILED", error);
    });
  } catch (error) {
    console.error("LED_PAYMENT_FAILED", error);
  }
  scheduleLedReturnToClock(orgId);
  const barrierStatus = await recordBarrierAttempt({
    actorId: completed.operation.operator_id,
    orgId,
    candidateId: completed.candidate.id,
    sessionId: completed.session.id,
    retryAttempt: false,
  });
  if (barrierStatus === "failed") {
    emitRelayFailed(orgId, {
      direction: "exit",
      plateNumber,
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }
  emitExitCompleted(orgId, {
    orgId,
    sessionId: completed.session.id,
    plateNumber,
    amount: Number(completed.session.amount),
    paymentMethod: "card",
    exitMethod: "auto",
    barrierStatus,
    sessionSource: completed.session.session_source,
    durationMinutes: completed.session.duration_minutes,
  });
  emitExitCandidateResolved(orgId, {
    candidateId: completed.candidate.id,
    orgId,
    status: "accepted",
    resolutionType: completed.resolutionType,
    sessionId: completed.session.id,
    barrierStatus,
    plateNumber,
    sessionSource: completed.session.session_source,
    amount: Number(completed.session.amount),
    paymentMethod: "card",
    exitMethod: "auto",
    durationMinutes: completed.session.duration_minutes,
  });
}

export async function confirmExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  input: { sessionId?: number; paymentMethod?: ExitPaymentMethod }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const transactionResult = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const organization = await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const selectedSessionId = input.sessionId ?? candidate.matched_session_id;
    if (!selectedSessionId) throw new ApiError("Sessiya tanlanmagan", 400);
    const session = await sessionSummaryQuery(trx)
      .where({ id: selectedSessionId, org_id: orgId })
      .forUpdate()
      .first();
    if (session?.status === "completed") {
      throw new ApiError("Bu mashina allaqachon chiqib ketgan", 409);
    }
    if (!session || session.status !== "active") {
      throw new ApiError("Tanlangan faol sessiya topilmadi", 409);
    }
    const isEmergency = input.paymentMethod === "emergency";
    if (
      session.session_source === "regular" &&
      input.paymentMethod !== "cash" &&
      input.paymentMethod !== "online" &&
      !isEmergency
    ) {
      throw new ApiError("payment_method 'cash', 'online' yoki 'emergency' bo'lishi kerak", 400);
    }
    const exitedAt = new Date();
    const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), exitedAt);
    const snapshotAmount = calculateTariffSnapshotAmount(session, durationMinutes);
    if (session.session_source === "regular" && !isEmergency && snapshotAmount === null) {
      throw new ApiError("Sessiyaning kirish vaqtidagi tarif snapshoti topilmadi", 409);
    }
    let amount = session.session_source === "regular" && !isEmergency ? snapshotAmount! : 0;
    const paymentMethod =
      session.session_source === "regular" && !isEmergency
        ? (input.paymentMethod as PaymentMethod)
        : session.payment_method;
    const exitMethod: ExitMethod = isEmergency ? "emergency" : "auto";

    let inpatientFreeExit = false;
    let appliedClinicDiscount: { id: number; discountPercent: number; originalAmount: number } | null = null;
    if (session.session_source === "regular" && !isEmergency && session.plate_number) {
      const todayDate = getOrgTodayDate(organization?.timezone);
      const inpatientVehicle = await findActiveInpatientVehicleForExit(
        orgId,
        session.plate_number,
        todayDate,
        trx
      );
      if (inpatientVehicle) {
        inpatientFreeExit = true;
        amount = 0;
      } else {
        const todayRange = getOrgTodayRange(organization?.timezone);
        const discount = await findPendingClinicDiscountForExit(orgId, session.plate_number, todayRange, trx);
        if (discount) {
          const originalAmount = amount;
          amount = Math.round((amount * (100 - discount.discount_percent)) / 100 * 100) / 100;
          appliedClinicDiscount = {
            id: discount.id,
            discountPercent: discount.discount_percent,
            originalAmount,
          };
        }
      }
    }
    let payment: { id: number; amount: number; payment_method: PaymentMethod; paid_at: Date } | null = null;
    if (session.session_source === "regular" && !isEmergency && !inpatientFreeExit) {
      const [paymentId] = await trx("tb_payments").insert({
        org_id: orgId,
        session_id: session.id,
        amount,
        payment_method: paymentMethod,
        paid_at: exitedAt,
        operator_id: actor.id,
      });
      payment = { id: paymentId, amount, payment_method: paymentMethod, paid_at: exitedAt };
    }
    await trx("tb_parking_sessions").where({ id: session.id, org_id: orgId }).update({
      status: "completed",
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount,
      payment_method: paymentMethod,
      exit_method: exitMethod,
      operator_id: actor.id,
      active_plate_key: null,
    });
    const resolutionType: ResolutionType = isEmergency
      ? "emergency_confirmed"
      : input.sessionId === undefined
        ? "exact"
        : "reassigned";
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidate.id, org_id: orgId }).update({
      status: "accepted",
      resolution_type: resolutionType,
      resolved_session_id: session.id,
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_completed",
      processing_reason:
        resolutionType === "emergency_confirmed"
          ? "candidate_emergency_confirmed"
          : `candidate_${resolutionType}_confirmed`,
      session_id: session.id,
      processed_at: trx.fn.now(),
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: input.sessionId === undefined ? "exit_candidate.accepted" : "exit_candidate.reassigned",
      target_type: "exit_candidate",
      target_id: candidate.id,
      details: JSON.stringify({
        orgId,
        detectedPlate: candidate.detected_plate,
        selectedSessionId: session.id,
        oldStatus: "active",
        newStatus: "completed",
        operatorId: actor.id,
        amount,
        paymentMethod:
          session.session_source === "regular"
            ? isEmergency
              ? "emergency"
              : paymentMethod
            : null,
        exitMethod,
      }),
    });
    if (inpatientFreeExit) {
      await trx("tb_activity_logs").insert({
        actor_id: actor.id,
        action: "inpatient_free_exit",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId,
          sessionId: session.id,
          plateNumber: session.plate_number,
        }),
      });
    }
    if (appliedClinicDiscount) {
      await markClinicDiscountUsed(appliedClinicDiscount.id, session.id, exitedAt, trx);
      await trx("tb_activity_logs").insert({
        actor_id: actor.id,
        action: "clinic_discount_applied",
        target_type: "exit_candidate",
        target_id: candidate.id,
        details: JSON.stringify({
          orgId,
          sessionId: session.id,
          discountId: appliedClinicDiscount.id,
          discountPercent: appliedClinicDiscount.discountPercent,
          originalAmount: appliedClinicDiscount.originalAmount,
          discountedAmount: amount,
        }),
      });
    }
    return {
      session: {
        ...session,
        status: "completed" as const,
        exited_at: exitedAt,
        duration_minutes: durationMinutes,
        amount,
        payment_method: paymentMethod,
        exit_method: exitMethod,
        active_plate_key: null,
      },
      payment,
      resolutionType,
      webhookEventId: candidate.webhook_event_id,
    };
  });
  sendTelegramExitNotification(orgId, actor.id, {
    plateNumber: displayPlateNumber(transactionResult.session.plate_number),
    amount: transactionResult.session.amount,
    paymentMethod:
      transactionResult.session.exit_method === "emergency"
        ? null
        : transactionResult.session.payment_method,
    ...(transactionResult.session.exit_method === "emergency"
      ? { exitMethod: "emergency" as const }
      : {}),
    imageUrl: `/api/webhook-events/${transactionResult.webhookEventId}/images/overview`,
    durationText: formatDuration(transactionResult.session.duration_minutes),
  });
  try {
    void ledService
      .showPayment(
        orgId,
        transactionResult.session.plate_number ?? "",
        transactionResult.session.amount
      )
      .catch((error) => {
        console.error("LED_PAYMENT_FAILED", error);
      });
  } catch (error) {
    console.error("LED_PAYMENT_FAILED", error);
  }
  scheduleLedReturnToClock(orgId);
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: false,
  });
  if (barrierStatus === "failed") {
    emitRelayFailed(orgId, {
      direction: "exit",
      plateNumber: displayPlateNumber(transactionResult.session.plate_number),
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }
  emitExitCompleted(orgId, {
    orgId,
    sessionId: transactionResult.session.id,
    plateNumber: displayPlateNumber(transactionResult.session.plate_number),
    amount: transactionResult.session.amount,
    paymentMethod:
      transactionResult.session.session_source === "regular" &&
      transactionResult.session.exit_method !== "emergency"
        ? transactionResult.session.payment_method
        : null,
    exitMethod: transactionResult.session.exit_method,
    barrierStatus,
    sessionSource: transactionResult.session.session_source,
    durationMinutes: transactionResult.session.duration_minutes,
  });
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "accepted",
    resolutionType: transactionResult.resolutionType,
    sessionId: transactionResult.session.id,
    barrierStatus,
    plateNumber: displayPlateNumber(transactionResult.session.plate_number),
    sessionSource: transactionResult.session.session_source,
    amount: transactionResult.session.amount,
    paymentMethod:
      transactionResult.session.session_source === "regular" &&
      transactionResult.session.exit_method !== "emergency"
        ? transactionResult.session.payment_method
        : null,
    exitMethod: transactionResult.session.exit_method,
    durationMinutes: transactionResult.session.duration_minutes,
  });
  if (
    transactionResult.session.payment_method === "cash" ||
    transactionResult.session.payment_method === "online"
  ) {
    abortActiveCardPaymentInBackground({
      orgId,
      sessionId: transactionResult.session.id,
      candidateId,
    });
  }
  return {
    candidate: await getCandidateByInternalId(orgId, candidateId),
    session: serializeSessionSummary(transactionResult.session),
    payment: transactionResult.payment,
    barrier_status: barrierStatus,
  };
}

export async function forceOpenExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  input: { reason?: ForceOpenReason; note?: string; enteredPlate?: string; isEmergency?: boolean }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const isEmergency = input.isEmergency === true;
  const reason = input.reason ?? (isEmergency ? "emergency" : "other");
  if (!FORCE_OPEN_REASONS.has(reason)) throw new ApiError("Majburiy ochish sababi noto'g'ri", 400);
  const note = input.note?.trim().slice(0, 500) || null;
  const resolutionNote = isEmergency
    ? note
      ? `emergency: ${note}`.slice(0, 500)
      : "emergency"
    : note;
  const enteredPlate = input.enteredPlate ? normalizePlate(input.enteredPlate) || null : null;
  const transactionResult = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const resolvedPlateNumber = displayPlateNumber(
      enteredPlate ?? candidate.detected_plate ?? candidate.suggested_plate
    );
    const event = await trx("tb_webhook_events")
      .select("overview_image_path", "vehicle_image_path")
      .where({ id: candidate.webhook_event_id, org_id: orgId })
      .first();
    const resolvedAt = new Date();
    const resolvedSession = candidate.resolved_session_id
      ? await trx<SessionSummary>("tb_parking_sessions")
          .select("id", "entered_at", "status")
          .where({ id: candidate.resolved_session_id, org_id: orgId })
          .forUpdate()
          .first()
      : null;
    if (resolvedSession && resolvedSession.status !== "completed") {
      await trx("tb_parking_sessions").where({ id: resolvedSession.id, org_id: orgId }).update({
        status: "completed",
        exited_at: resolvedAt,
        duration_minutes: calculateDurationMinutes(new Date(resolvedSession.entered_at), resolvedAt),
        amount: 0,
        exit_method: isEmergency ? "emergency" : "forced",
        operator_id: actor.id,
        active_plate_key: null,
      });
    }
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
      status: "dismissed",
      resolution_type: isEmergency ? "emergency_forced_open" : "forced_open",
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      resolution_note: resolutionNote,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_candidate_forced_open",
      processing_reason: reason,
      session_id: resolvedSession?.id ?? null,
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "exit_candidate.forced_open",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        operatorId: actor.id,
        orgId,
        reason,
        note,
        isEmergency,
        enteredPlate,
        candidateId,
        webhookEventId: candidate.webhook_event_id,
        resolvedSessionId: resolvedSession?.id ?? null,
        exitImageRef: event?.overview_image_path ?? event?.vehicle_image_path ?? null,
        exitMethod: resolvedSession ? (isEmergency ? "emergency" : "forced") : null,
      }),
    });
    return {
      plateNumber: resolvedPlateNumber,
      webhookEventId: candidate.webhook_event_id,
      resolvedSessionId: resolvedSession?.id ?? null,
      resolvedAt,
      isEmergency,
    };
  });
  sendForceOpenTelegramNotification(orgId, {
    ...transactionResult,
    confirmedByUserId: actor.id,
  });
  showLedPlatePreview(orgId, transactionResult.plateNumber);
  scheduleLedReturnToClock(orgId);
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: false,
  });
  const resolvedCandidate = await getCandidateByInternalId(orgId, candidateId);
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "dismissed",
    resolutionType: transactionResult.isEmergency ? "emergency_forced_open" : "forced_open",
    sessionId: transactionResult.resolvedSessionId,
    barrierStatus,
    plateNumber: resolvedCandidate.detected_plate,
    exitMethod: transactionResult.isEmergency ? "emergency" : "forced",
  });
  return { candidate: resolvedCandidate, barrier_status: barrierStatus };
}

export async function cancelExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const transactionResult = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    if (candidate.matched_session_id !== null) {
      throw new ApiError("Sessiyaga moslangan chiqishni bekor qilib bo'lmaydi", 409);
    }
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
      status: "dismissed",
      resolution_type: "exit_cancelled",
      resolved_by: actor.id,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    });
    await trx("tb_webhook_events").where({ id: candidate.webhook_event_id, org_id: orgId }).update({
      processing_result: "exit_candidate_cancelled",
      processing_reason: "operator_cancelled_exit",
      session_id: null,
      processed_at: trx.fn.now(),
    });
    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "exit_candidate.cancelled",
      target_type: "exit_candidate",
      target_id: candidateId,
      details: JSON.stringify({
        operatorId: actor.id,
        orgId,
        candidateId,
        webhookEventId: candidate.webhook_event_id,
        detectedPlate: candidate.detected_plate,
        suggestedPlate: candidate.suggested_plate,
      }),
    });
    return { plateNumber: candidate.detected_plate ?? candidate.suggested_plate };
  });
  abortCandidateCardPaymentInBackground({ orgId, candidateId });
  scheduleLedReturnToClock(orgId);
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "dismissed",
    resolutionType: "exit_cancelled",
    sessionId: null,
    barrierStatus: null,
    plateNumber: transactionResult.plateNumber,
  });
  return getCandidateByInternalId(orgId, candidateId);
}

export async function retryExitCandidateBarrier(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const candidate = await db<CandidateRow>("tb_exit_candidates")
    .where({ id: candidateId, org_id: orgId })
    .first();
  if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
  if (candidate.status !== "accepted" && candidate.status !== "dismissed") {
    throw new ApiError("Shlagbaumni qayta ochish uchun candidate hal qilingan bo'lishi kerak", 400);
  }
  const latestAttempt = await db("tb_activity_logs")
    .where({ target_type: "exit_candidate", target_id: candidateId })
    .whereIn("action", BARRIER_AUDIT_ACTIONS)
    .orderBy("id", "desc")
    .first();
  const details = parseActivityDetails(latestAttempt?.details);
  if (details.orgId === orgId && (details.barrierStatus === "disabled" || details.barrierStatus === "not_configured")) {
    throw new ApiError("Shlagbaum konfiguratsiya qilinmagan, administrator bilan bog'laning", 400);
  }
  if (!latestAttempt || details.orgId !== orgId || details.barrierStatus !== "failed") {
    throw new ApiError("Oxirgi shlagbaum ochish urinishi failed holatida emas", 400);
  }
  const barrierStatus = await recordBarrierAttempt({
    actorId: actor.id,
    orgId,
    candidateId,
    retryAttempt: true,
  });
  emitPublicExitStatusChanged(orgId, await getExitDisplayStatus(orgId));
  return { barrier_status: barrierStatus };
}

export function acceptExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  paymentMethod?: Exclude<PaymentMethod, "card">
) {
  console.warn(`Deprecated exit candidate accept endpoint ishlatildi: candidate_id=${candidateId}`);
  return confirmExitCandidate(actor, requestedOrgId, candidateId, { paymentMethod });
}

export function reassignExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  sessionId: number,
  paymentMethod?: Exclude<PaymentMethod, "card">
) {
  console.warn(`Deprecated exit candidate reassign endpoint ishlatildi: candidate_id=${candidateId}`);
  return confirmExitCandidate(actor, requestedOrgId, candidateId, { sessionId, paymentMethod });
}

export async function dismissExitCandidate(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  candidateId: number,
  note?: string
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const detectedPlate = await db.transaction(async (trx) => {
    const candidate = await trx<CandidateRow>("tb_exit_candidates")
      .where({ id: candidateId, org_id: orgId })
      .forUpdate()
      .first();
    if (!candidate) throw new ApiError("Chiqish nomzodi topilmadi", 404);
    if (candidate.status !== "pending") throw new ApiError("Bu chiqish allaqachon hal qilingan", 409);
    const matchedSession = candidate.matched_session_id
      ? await trx("tb_parking_sessions")
          .select("id", "status")
          .where({ id: candidate.matched_session_id, org_id: orgId })
          .first()
      : null;
    const resolvedAt = new Date();
    await trx("tb_exit_candidates").where({ id: candidateId, org_id: orgId }).update({
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
    return candidate.detected_plate;
  });
  emitExitCandidateResolved(orgId, {
    candidateId,
    orgId,
    status: "dismissed",
    resolutionType: "dismissed",
    sessionId: null,
    barrierStatus: null,
    plateNumber: detectedPlate,
  });
  return getCandidateByInternalId(orgId, candidateId);
}
