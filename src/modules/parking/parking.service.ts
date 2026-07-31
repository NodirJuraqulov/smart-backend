import type { Knex } from "knex";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdFilter, resolveOrgIdRequired } from "@/utils/orgScope";
import {
  emitEntryDetected,
  emitExitAwaitingPayment,
  emitExitCompleted,
  emitParkingFull,
  emitPlateNotRecognizedForExit,
  emitRelayFailed,
} from "@/websocket/socketServer";
import { openBarrier } from "@/modules/relay/relay.service";
import { printReceipt } from "@/modules/printer/printer.service";
import { logActivity } from "@/utils/activityLog";
import { env } from "@/config/env";
import { NormalizedCameraEvent } from "@/modules/webhook/parsers/normalizedCameraEvent";
import { resolveParkingImageAbsolutePath, saveParkingImages } from "./parkingImage.service";
import { applyInsideSessionsFilter, INSIDE_SESSION_STATUSES } from "./sessionStatus";

type SessionSource = "regular" | "subscription" | "vip";

export interface TariffIntervalSnapshot {
  from_minutes: number;
  to_minutes: number | null;
  price: number | string;
}

interface SessionRecord {
  id: number;
  org_id: number;
  plate_number: string;
  entered_at: Date;
  exited_at: Date | null;
  duration_minutes: number | null;
  amount: string | null;
  status: "active" | "completed" | "awaiting_payment";
  entry_method: "auto" | "manual";
  exit_method: "auto" | "manual" | "forced" | null;
  image_entry: string | null;
  image_exit: string | null;
  entry_overview_image_path: string | null;
  entry_vehicle_image_path: string | null;
  entry_plate_image_path: string | null;
  exit_overview_image_path: string | null;
  exit_vehicle_image_path: string | null;
  exit_plate_image_path: string | null;
  operator_id: number | null;
  session_source: SessionSource;
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: TariffIntervalSnapshot[] | string | null;
  payment_method: "cash" | "online";
  created_at: Date;
}

interface TariffRecord {
  id: number;
  org_id: number;
  price_per_hour: string;
  grace_period_minutes: number;
  is_active: boolean;
}

function activePlateKey(orgId: number, plateNumber: string): string {
  return `${orgId}:${plateNumber}`;
}

function sessionsBaseQuery(executor: Knex) {
  return executor<SessionRecord>("tb_parking_sessions").select(
    "id",
    "org_id",
    "plate_number",
    "entered_at",
    "exited_at",
    "duration_minutes",
    "amount",
    "status",
    "entry_method",
    "exit_method",
    "image_entry",
    "image_exit",
    "entry_overview_image_path",
    "entry_vehicle_image_path",
    "entry_plate_image_path",
    "exit_overview_image_path",
    "exit_vehicle_image_path",
    "exit_plate_image_path",
    "operator_id",
    "session_source",
    "tariff_price_per_hour",
    "tariff_grace_period_minutes",
    "tariff_intervals_snapshot",
    "payment_method",
    "created_at"
  );
}

function parseIntervalsSnapshot(
  raw: TariffIntervalSnapshot[] | string | null
): TariffIntervalSnapshot[] | null {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function timeStringToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isWithinWorkHours(workStart: string, workEnd: string, nowMinutes: number): boolean {
  const startMinutes = timeStringToMinutes(workStart);
  const endMinutes = timeStringToMinutes(workEnd);

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

export function calculateDurationMinutes(enteredAt: Date, exitedAt: Date): number {
  const rawDurationMs = exitedAt.getTime() - enteredAt.getTime();
  return Math.max(0, Math.ceil(rawDurationMs / 60000));
}

export function calculateIntervalAmount(
  durationMinutes: number,
  intervals: TariffIntervalSnapshot[]
): number {
  const sorted = [...intervals].sort((a, b) => a.from_minutes - b.from_minutes);
  if (sorted.length === 0 || durationMinutes < sorted[0].from_minutes) {
    return 0;
  }

  let matched = sorted[0];
  for (const interval of sorted) {
    if (interval.from_minutes > durationMinutes) break;
    matched = interval;
  }

  return Number(matched.price);
}

export function calculateAmount(
  durationMinutes: number,
  pricePerHour: number,
  gracePeriodMinutes: number,
  intervals?: TariffIntervalSnapshot[] | null
): number {
  if (intervals && intervals.length > 0) {
    const intervalAmount = calculateIntervalAmount(durationMinutes, intervals);
    return Number.isFinite(intervalAmount) && intervalAmount >= 0 ? Math.round(intervalAmount * 100) / 100 : 0;
  }
  if (durationMinutes <= gracePeriodMinutes) {
    return 0;
  }
  const amount = Math.ceil(durationMinutes / 60) * pricePerHour;
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : 0;
}

function imageUrl(sessionId: number, kind: string, imagePath: string | null): string | null {
  return imagePath ? `${env.publicBaseUrl}/api/parking/sessions/${sessionId}/images/${kind}` : null;
}

function withImageUrls(session: SessionRecord) {
  const {
    entry_overview_image_path: _entryOverviewPath,
    entry_vehicle_image_path: _entryVehiclePath,
    entry_plate_image_path: _entryPlatePath,
    exit_overview_image_path: _exitOverviewPath,
    exit_vehicle_image_path: _exitVehiclePath,
    exit_plate_image_path: _exitPlatePath,
    ...publicSession
  } = session;
  return {
    ...publicSession,
    entryOverviewImageUrl: imageUrl(session.id, "entry-overview", session.entry_overview_image_path),
    entryVehicleImageUrl: imageUrl(session.id, "entry-vehicle", session.entry_vehicle_image_path),
    entryPlateImageUrl: imageUrl(session.id, "entry-plate", session.entry_plate_image_path),
    exitOverviewImageUrl: imageUrl(session.id, "exit-overview", session.exit_overview_image_path),
    exitVehicleImageUrl: imageUrl(session.id, "exit-vehicle", session.exit_vehicle_image_path),
    exitPlateImageUrl: imageUrl(session.id, "exit-plate", session.exit_plate_image_path),
  };
}

async function withCurrentEstimate(session: SessionRecord, now = new Date()) {
  if (session.status !== "active") return withImageUrls(session);
  const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), now);
  try {
    let intervals = parseIntervalsSnapshot(session.tariff_intervals_snapshot);
    let pricePerHour = session.tariff_price_per_hour === null ? null : Number(session.tariff_price_per_hour);
    let gracePeriodMinutes = session.tariff_grace_period_minutes ?? 0;
    if (session.session_source === "regular" && !intervals && pricePerHour === null) {
      const organization = await db("tb_organizations").select("pricing_mode").where({ id: session.org_id }).first();
      if (organization?.pricing_mode === "interval") {
        intervals = await findTariffIntervals(db, session.org_id);
      } else {
        const tariff = await findTariff(db, session.org_id);
        pricePerHour = Number(tariff.price_per_hour);
        gracePeriodMinutes = tariff.grace_period_minutes;
      }
    }
    const estimatedAmount =
      session.session_source !== "regular"
        ? 0
        : calculateAmount(durationMinutes, pricePerHour ?? 0, gracePeriodMinutes, intervals);
    return {
      ...withImageUrls(session),
      current_duration_minutes: durationMinutes,
      estimated_amount: estimatedAmount,
      fee_calculation_status: "calculated" as const,
    };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      ...withImageUrls(session),
      current_duration_minutes: durationMinutes,
      estimated_amount: null,
      fee_calculation_status: "tariff_not_configured" as const,
    };
  }
}

async function attachCameraImages(
  session: SessionRecord,
  direction: "entry" | "exit",
  event: NormalizedCameraEvent
): Promise<SessionRecord> {
  try {
    const paths = await saveParkingImages(
      session.org_id,
      session.id,
      direction,
      { buffer: event.overviewImage, originalFileName: event.overviewImageFileName },
      { buffer: event.vehicleImage, originalFileName: event.vehicleImageFileName },
      { buffer: event.plateImage, originalFileName: event.plateImageFileName }
    );
    const updates: Record<string, string> = {};
    if (paths.overviewPath) updates[`${direction}_overview_image_path`] = paths.overviewPath;
    if (paths.vehiclePath) updates[`${direction}_vehicle_image_path`] = paths.vehiclePath;
    if (paths.platePath) updates[`${direction}_plate_image_path`] = paths.platePath;
    if (Object.keys(updates).length > 0) {
      await db("tb_parking_sessions").where({ id: session.id, org_id: session.org_id }).update(updates);
    }
    return { ...session, ...updates };
  } catch (err) {
    console.warn(
      `ANPR rasmlarini sessiyaga biriktirib bo'lmadi (org=${session.org_id}, session=${session.id}, direction=${direction}):`,
      err instanceof Error ? err.message : err
    );
    return session;
  }
}

async function assertWithinWorkHours(orgId: number): Promise<void> {
  const settings = await db("tb_settings")
    .select("work_hours_enabled", "work_start", "work_end")
    .where({ org_id: orgId })
    .first();

  if (!settings?.work_hours_enabled || !settings.work_start || !settings.work_end) {
    return;
  }

  const organization = await db("tb_organizations").select("timezone").where({ id: orgId }).first();
  const now = DateTime.now().setZone(organization?.timezone);
  const nowMinutes = now.hour * 60 + now.minute;

  if (!isWithinWorkHours(settings.work_start, settings.work_end, nowMinutes)) {
    const start = settings.work_start.slice(0, 5);
    const end = settings.work_end.slice(0, 5);
    throw new ApiError(`Stoyanka hozir yopiq — ish vaqti: ${start} - ${end}`, 403);
  }
}

async function assertCapacityAvailable(orgId: number): Promise<void> {
  const organization = await db("tb_organizations").select("total_capacity").where({ id: orgId }).first();
  if (organization?.total_capacity === null || organization?.total_capacity === undefined) {
    return;
  }

  const [{ count }] = await applyInsideSessionsFilter(
    db("tb_parking_sessions").where({ org_id: orgId })
  ).count<{ count: string }[]>("id as count");

  if (Number(count) >= organization.total_capacity) {
    throw new ApiError("Stoyanka to'liq, bo'sh joy yo'q", 400, { reason: "parking_full" });
  }
}

async function assertNoActiveSessionForPlate(orgId: number, plateNumber: string) {
  const existing = await sessionsBaseQuery(db)
    .where({ org_id: orgId, plate_number: plateNumber })
    .whereIn("status", [...INSIDE_SESSION_STATUSES])
    .first();
  if (existing) {
    throw new ApiError("Bu mashina hali stoyankada!", 409, { existing_session: existing });
  }
}

async function insertActiveSession(input: {
  org_id: number;
  plate_number: string;
  entry_method: "auto" | "manual";
  image_entry: string | null;
  operator_id: number | null;
  entered_at: Date;
  session_source: SessionSource;
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: string | null;
}) {
  try {
    const [id] = await db("tb_parking_sessions").insert({
      org_id: input.org_id,
      plate_number: input.plate_number,
      entered_at: input.entered_at,
      status: "active",
      entry_method: input.entry_method,
      image_entry: input.image_entry,
      operator_id: input.operator_id,
      active_plate_key: activePlateKey(input.org_id, input.plate_number),
      session_source: input.session_source,
      tariff_price_per_hour: input.tariff_price_per_hour,
      tariff_grace_period_minutes: input.tariff_grace_period_minutes,
      tariff_intervals_snapshot: input.tariff_intervals_snapshot,
    });
    return await sessionsBaseQuery(db).where({ id }).first();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await sessionsBaseQuery(db)
        .where({ org_id: input.org_id, plate_number: input.plate_number })
        .whereIn("status", [...INSIDE_SESSION_STATUSES])
        .first();
      throw new ApiError("Bu mashina hali stoyankada!", 409, { existing_session: existing });
    }
    throw err;
  }
}

async function findTariff(executor: Knex, orgId: number) {
  const tariff = await executor<TariffRecord>("tb_tariffs").where({ org_id: orgId, is_active: true }).first();
  if (!tariff) {
    throw new ApiError("Bu stoyanka uchun tarif topilmadi", 400);
  }
  return tariff;
}

async function getOrgToday(orgId: number): Promise<string> {
  const organization = await db("tb_organizations").select("timezone").where({ id: orgId }).first();
  return DateTime.now().setZone(organization?.timezone).toFormat("yyyy-MM-dd");
}

async function resolveSessionSource(orgId: number, plateNumber: string): Promise<SessionSource> {
  const vip = await db("tb_vip_vehicles").where({ org_id: orgId, plate_number: plateNumber }).first();
  if (vip) {
    return "vip";
  }

  const today = await getOrgToday(orgId);
  const subscription = await db("tb_subscriptions")
    .where({ org_id: orgId, plate_number: plateNumber })
    .andWhere("end_date", ">=", today)
    .first();
  if (subscription) {
    return "subscription";
  }

  return "regular";
}

interface TariffIntervalRow extends TariffIntervalSnapshot {
  org_id: number;
}

async function findTariffIntervals(executor: Knex, orgId: number): Promise<TariffIntervalSnapshot[]> {
  const intervals = await executor<TariffIntervalRow>("tb_tariff_intervals")
    .select("from_minutes", "to_minutes", "price")
    .where({ org_id: orgId })
    .orderBy("from_minutes", "asc");
  if (intervals.length === 0) {
    throw new ApiError("Bu stoyanka uchun interval tarif topilmadi", 400);
  }
  return intervals;
}

interface EntryPricing {
  tariff_price_per_hour: string | null;
  tariff_grace_period_minutes: number | null;
  tariff_intervals_snapshot: string | null;
}

async function resolveEntryPricing(orgId: number, sessionSource: SessionSource): Promise<EntryPricing> {
  if (sessionSource !== "regular") {
    return { tariff_price_per_hour: null, tariff_grace_period_minutes: null, tariff_intervals_snapshot: null };
  }

  const organization = await db("tb_organizations")
    .select("pricing_mode")
    .where({ id: orgId })
    .first();

  if (organization?.pricing_mode === "interval") {
    const intervals = await findTariffIntervals(db, orgId);
    return {
      tariff_price_per_hour: null,
      tariff_grace_period_minutes: null,
      tariff_intervals_snapshot: JSON.stringify(intervals),
    };
  }

  const tariff = await findTariff(db, orgId);
  return {
    tariff_price_per_hour: tariff.price_per_hour,
    tariff_grace_period_minutes: tariff.grace_period_minutes,
    tariff_intervals_snapshot: null,
  };
}

async function findSessionOrFail(id: number) {
  const session = await sessionsBaseQuery(db).where({ id }).first();
  if (!session) {
    throw new ApiError("Sessiya topilmadi", 404);
  }
  return session;
}

function assertInScope(actor: AuthTokenPayload, session: SessionRecord) {
  if ((actor.role === "operator" || actor.role === "owner") && session.org_id !== actor.org_id) {
    throw new ApiError("Sessiya topilmadi", 404);
  }
}

async function completeSession(
  orgId: number,
  plateNumber: string,
  operatorId: number | null,
  exitMethod: "auto" | "manual",
  imageExit: string | null,
  exitedAt: Date,
  paymentMethod: "cash" | "online" = "cash"
) {
  return db.transaction(async (trx) => {
    const session = await sessionsBaseQuery(trx)
      .where({ org_id: orgId, plate_number: plateNumber, status: "active" })
      .orderBy("entered_at", "desc")
      .forUpdate()
      .first();

    if (!session) {
      throw new ApiError(`"${plateNumber}" nomeri uchun faol sessiya topilmadi`, 404);
    }

    const enteredAt = new Date(session.entered_at);
    const rawDurationMs = exitedAt.getTime() - enteredAt.getTime();

    if (rawDurationMs < 0) {
      console.warn(
        `ANOMALIYA: sessiya #${session.id} (${exitMethod} chiqish) uchun manfiy davomiylik aniqlandi ` +
          `(entered_at: ${enteredAt.toISOString()}, exited_at: ${exitedAt.toISOString()}) — ` +
          `soat sinxronizatsiyasi buzilgan bo'lishi mumkin, duration_minutes=0 va amount=0 deb belgilandi`
      );
    }

    const durationMinutes = calculateDurationMinutes(enteredAt, exitedAt);

    let amount: number;
    if (session.session_source !== "regular") {
      amount = 0;
    } else {
      const intervalsSnapshot = parseIntervalsSnapshot(session.tariff_intervals_snapshot);
      if (intervalsSnapshot) {
        amount = calculateAmount(durationMinutes, 0, 0, intervalsSnapshot);
      } else if (session.tariff_price_per_hour !== null) {
        const pricePerHour = Number(session.tariff_price_per_hour);
        const gracePeriodMinutes = session.tariff_grace_period_minutes ?? 0;
        amount = calculateAmount(durationMinutes, pricePerHour, gracePeriodMinutes);
      } else {
        const tariff = await findTariff(trx, orgId);
        amount = calculateAmount(durationMinutes, Number(tariff.price_per_hour), tariff.grace_period_minutes);
      }
    }

    const sessionUpdates: Record<string, unknown> = {
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount,
      status: "completed",
      exit_method: exitMethod,
      image_exit: imageExit,
      operator_id: operatorId,
      active_plate_key: null,
    };
    if (session.session_source === "regular") {
      sessionUpdates.payment_method = paymentMethod;
    }

    await trx("tb_parking_sessions").where({ id: session.id }).update(sessionUpdates);

    const [paymentId] = await trx("tb_payments").insert({
      org_id: orgId,
      session_id: session.id,
      amount,
      payment_method: "cash",
    });

    return {
      session: {
        ...session,
        exited_at: exitedAt,
        duration_minutes: durationMinutes,
        amount: String(amount),
        status: "completed" as const,
        exit_method: exitMethod,
        image_exit: imageExit,
        operator_id: operatorId,
        payment_method: session.session_source === "regular" ? paymentMethod : session.payment_method,
      },
      payment: {
        id: paymentId,
        org_id: orgId,
        session_id: session.id,
        amount: String(amount),
        payment_method: "cash" as const,
        paid_at: exitedAt,
      },
    };
  });
}

export async function entryManual(
  actor: AuthTokenPayload,
  input: { org_id?: number; plate_number: string }
) {
  const orgId = resolveOrgIdRequired(actor, input.org_id);

  await assertWithinWorkHours(orgId);
  await assertCapacityAvailable(orgId);
  await assertNoActiveSessionForPlate(orgId, input.plate_number);
  const sessionSource = await resolveSessionSource(orgId, input.plate_number);
  const pricing = await resolveEntryPricing(orgId, sessionSource);

  const session = await insertActiveSession({
    org_id: orgId,
    plate_number: input.plate_number,
    entry_method: "manual",
    image_entry: null,
    operator_id: actor.role === "operator" || actor.role === "owner" ? actor.id : null,
    entered_at: new Date(),
    session_source: sessionSource,
    tariff_price_per_hour: pricing.tariff_price_per_hour,
    tariff_grace_period_minutes: pricing.tariff_grace_period_minutes,
    tariff_intervals_snapshot: pricing.tariff_intervals_snapshot,
  });

  await openBarrierOrWarn(orgId, "entry", input.plate_number);
  emitEntryDetected(orgId, { plateNumber: input.plate_number, enteredAt: session!.entered_at });

  return session;
}

export async function exitManual(
  actor: AuthTokenPayload,
  input: { org_id?: number; plate_number: string; payment_method?: "cash" | "online" }
) {
  const orgId = resolveOrgIdRequired(actor, input.org_id);
  const operatorId = actor.role === "operator" || actor.role === "owner" ? actor.id : null;
  const result = await completeSession(
    orgId,
    input.plate_number,
    operatorId,
    "manual",
    null,
    new Date(),
    input.payment_method ?? "cash"
  );

  await openBarrierOrWarn(orgId, "exit", input.plate_number);

  const printResult = await printReceiptForSession(actor, result.session.id);
  if (!printResult.success) {
    console.warn(`Chek chop etilmadi (session #${result.session.id}): ${JSON.stringify(printResult)}`);
  }

  emitExitCompleted(orgId, {
    plateNumber: input.plate_number,
    amount: Number(result.session.amount),
  });

  return result;
}

async function openBarrierOrWarn(
  orgId: number,
  direction: "entry" | "exit",
  plateNumber: string
): Promise<void> {
  const result = await openBarrier(orgId, direction);
  if (result.status === "failed") {
    emitRelayFailed(orgId, {
      direction,
      plateNumber,
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }
}

async function moveSessionToAwaitingPayment(
  orgId: number,
  plateNumber: string,
  exitedAt: Date
): Promise<SessionRecord> {
  return db.transaction(async (trx) => {
    const session = await sessionsBaseQuery(trx)
      .where({ org_id: orgId, plate_number: plateNumber, status: "active" })
      .orderBy("entered_at", "desc")
      .forUpdate()
      .first();

    if (!session) {
      throw new ApiError(`"${plateNumber}" nomeri uchun faol sessiya topilmadi`, 404);
    }

    const enteredAt = new Date(session.entered_at);
    const durationMinutes = calculateDurationMinutes(enteredAt, exitedAt);

    const intervalsSnapshot = parseIntervalsSnapshot(session.tariff_intervals_snapshot);
    let amount: number;
    if (intervalsSnapshot) {
      amount = calculateAmount(durationMinutes, 0, 0, intervalsSnapshot);
    } else if (session.tariff_price_per_hour !== null) {
      const pricePerHour = Number(session.tariff_price_per_hour);
      const gracePeriodMinutes = session.tariff_grace_period_minutes ?? 0;
      amount = calculateAmount(durationMinutes, pricePerHour, gracePeriodMinutes);
    } else {
      const tariff = await findTariff(trx, orgId);
      amount = calculateAmount(durationMinutes, Number(tariff.price_per_hour), tariff.grace_period_minutes);
    }

    await trx("tb_parking_sessions").where({ id: session.id }).update({
      status: "awaiting_payment",
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount,
      exit_method: "auto",
      active_plate_key: activePlateKey(orgId, plateNumber),
    });

    return {
      ...session,
      status: "awaiting_payment" as const,
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount: String(amount),
      exit_method: "auto",
    };
  });
}

export async function resolveExitCandidateSession(
  trx: Knex.Transaction,
  input: { orgId: number; sessionId: number; cameraEventAt: Date }
) {
  const session = await sessionsBaseQuery(trx)
    .where({ id: input.sessionId, org_id: input.orgId, status: "active" })
    .forUpdate()
    .first();
  if (!session) {
    throw new ApiError("Tanlangan faol sessiya topilmadi", 409);
  }

  const enteredAt = new Date(session.entered_at);
  const now = new Date();
  const cameraEventAt = new Date(input.cameraEventAt);
  const cameraTimeIsSafe =
    Number.isFinite(cameraEventAt.getTime()) &&
    cameraEventAt.getTime() >= enteredAt.getTime() &&
    cameraEventAt.getTime() <= now.getTime() + 5 * 60 * 1000;
  const exitedAt = cameraTimeIsSafe ? cameraEventAt : now.getTime() >= enteredAt.getTime() ? now : enteredAt;
  const durationMinutes = calculateDurationMinutes(enteredAt, exitedAt);

  if (session.session_source !== "regular") {
    await trx("tb_parking_sessions").where({ id: session.id, org_id: input.orgId }).update({
      status: "completed",
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount: 0,
      exit_method: "auto",
      active_plate_key: null,
    });
    return {
      status: "completed" as const,
      session: {
        ...session,
        status: "completed" as const,
        exited_at: exitedAt,
        duration_minutes: durationMinutes,
        amount: "0",
        exit_method: "auto" as const,
      },
    };
  }

  const intervalsSnapshot = parseIntervalsSnapshot(session.tariff_intervals_snapshot);
  let amount: number;
  if (intervalsSnapshot) {
    amount = calculateAmount(durationMinutes, 0, 0, intervalsSnapshot);
  } else if (session.tariff_price_per_hour !== null) {
    amount = calculateAmount(
      durationMinutes,
      Number(session.tariff_price_per_hour),
      session.tariff_grace_period_minutes ?? 0
    );
  } else {
    const tariff = await findTariff(trx, input.orgId);
    amount = calculateAmount(durationMinutes, Number(tariff.price_per_hour), tariff.grace_period_minutes);
  }

  await trx("tb_parking_sessions").where({ id: session.id, org_id: input.orgId }).update({
    status: "awaiting_payment",
    exited_at: exitedAt,
    duration_minutes: durationMinutes,
    amount,
    exit_method: "auto",
  });
  return {
    status: "awaiting_payment" as const,
    session: {
      ...session,
      status: "awaiting_payment" as const,
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount: String(amount),
      exit_method: "auto" as const,
    },
  };
}

interface CameraParkingInput {
  orgId: number;
  event: NormalizedCameraEvent & { plateNumber: string };
}

export async function createEntryFromWebhook(input: CameraParkingInput) {
  const { orgId, event } = input;
  const plateNumber = event.plateNumber;
  try {
    await assertWithinWorkHours(orgId);
    await assertCapacityAvailable(orgId);
    await assertNoActiveSessionForPlate(orgId, plateNumber);

    const sessionSource = await resolveSessionSource(orgId, plateNumber);
    const pricing = await resolveEntryPricing(orgId, sessionSource);

    let session = await insertActiveSession({
      org_id: orgId,
      plate_number: plateNumber,
      entry_method: "auto",
      image_entry: null,
      operator_id: null,
      entered_at: new Date(),
      session_source: sessionSource,
      tariff_price_per_hour: pricing.tariff_price_per_hour,
      tariff_grace_period_minutes: pricing.tariff_grace_period_minutes,
      tariff_intervals_snapshot: pricing.tariff_intervals_snapshot,
    });
    session = await attachCameraImages(session!, "entry", event);

    await openBarrierOrWarn(orgId, "entry", plateNumber);
    emitEntryDetected(orgId, { plateNumber, enteredAt: session!.entered_at });
    await logActivity(null, "parking.entry_webhook", "session", session!.id, { plateNumber, orgId });

    return { created: true as const, session: withImageUrls(session), confidence: event.confidence };
  } catch (err) {
    if (err instanceof ApiError && err.details?.reason === "parking_full") {
      emitParkingFull(orgId, { plateNumber });
      return { created: false as const, reason: "parking_full" as const };
    }
    if (err instanceof ApiError && err.statusCode === 409) {
      console.warn(`Webhook kirish: "${plateNumber}" mashinasi allaqachon stoyankada (org_id: ${orgId})`);
      return { created: false as const, reason: "already_active" as const };
    }
    if (err instanceof ApiError) {
      console.warn(`Webhook kirish rad etildi (org_id: ${orgId}, plate: ${plateNumber}): ${err.message}`);
      return { created: false as const, reason: "rejected" as const };
    }
    throw err;
  }
}

export async function createExitFromWebhook(input: CameraParkingInput) {
  const { orgId, event } = input;
  const plateNumber = event.plateNumber;
  try {
    const activeSession = await sessionsBaseQuery(db)
      .where({ org_id: orgId, plate_number: plateNumber, status: "active" })
      .orderBy("entered_at", "desc")
      .first();

    if (!activeSession) {
      console.warn(`Webhook chiqish: "${plateNumber}" uchun faol sessiya topilmadi (org_id: ${orgId})`);
      emitPlateNotRecognizedForExit(orgId, {
        plateNumber,
        message: "Operator bilan bog'laning — nomer faol sessiyalar orasida topilmadi",
      });
      return { updated: false as const, reason: "not_found" as const };
    }

    const exitedAt = new Date();

    if (activeSession.session_source !== "regular") {
      const result = await completeSession(orgId, plateNumber, null, "auto", null, exitedAt);
      const sessionWithImages = await attachCameraImages(result.session, "exit", event);
      await openBarrierOrWarn(orgId, "exit", plateNumber);
      emitExitCompleted(orgId, { plateNumber, amount: 0 });
      return { updated: true as const, status: "completed" as const, session: withImageUrls(sessionWithImages), confidence: event.confidence };
    }

    let session = await moveSessionToAwaitingPayment(orgId, plateNumber, exitedAt);
    session = await attachCameraImages(session, "exit", event);
    emitExitAwaitingPayment(orgId, {
      plateNumber,
      amount: Number(session.amount),
      enteredAt: session.entered_at,
      durationMinutes: session.duration_minutes,
    });
    await logActivity(null, "parking.exit_webhook", "session", session.id, {
      plateNumber,
      amount: Number(session.amount),
    });

    return { updated: true as const, status: "awaiting_payment" as const, session: withImageUrls(session), confidence: event.confidence };
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn(`Webhook chiqish rad etildi (org_id: ${orgId}, plate: ${plateNumber}): ${err.message}`);
      return { updated: false as const, reason: "rejected" as const };
    }
    throw err;
  }
}

export async function listActive(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdFilter(actor, requestedOrgId);
  const query = sessionsBaseQuery(db)
    .where({ status: "active" })
    .orderBy("entered_at", "desc");
  if (orgId !== undefined) {
    query.andWhere({ org_id: orgId });
  }
  const sessions = await query;
  const now = new Date();
  return Promise.all(sessions.map((session) => withCurrentEstimate(session, now)));
}

interface ListSessionsFilters {
  org_id?: number;
  date?: string;
  plate_number?: string;
  status?: "active" | "completed";
  page: number;
  limit: number;
}

function applySessionFilters<T extends Knex.QueryBuilder>(query: T, orgId: number | undefined, filters: ListSessionsFilters): T {
  if (orgId !== undefined) {
    query.andWhere({ org_id: orgId });
  }
  if (filters.status) {
    query.andWhere({ status: filters.status });
  }
  if (filters.plate_number) {
    query.andWhere("plate_number", "like", `%${escapeLikePattern(filters.plate_number)}%`);
  }
  if (filters.date) {
    const dayStart = new Date(`${filters.date}T00:00:00`);
    const dayEnd = new Date(`${filters.date}T23:59:59.999`);
    query.andWhereBetween("entered_at", [dayStart, dayEnd]);
  }
  return query;
}

export async function listSessions(actor: AuthTokenPayload, filters: ListSessionsFilters) {
  const orgId = resolveOrgIdFilter(actor, filters.org_id);

  const [{ count }] = await applySessionFilters(db("tb_parking_sessions"), orgId, filters).count<
    { count: string }[]
  >("id as count");
  const total = Number(count);

  const sessions = await applySessionFilters(sessionsBaseQuery(db), orgId, filters)
    .orderBy("entered_at", "desc")
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);

  const now = new Date();
  return {
    sessions: await Promise.all(sessions.map((session) => withCurrentEstimate(session, now))),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.ceil(total / filters.limit) || 1,
    },
  };
}

export async function getSessionById(actor: AuthTokenPayload, id: number) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);
  return withCurrentEstimate(session);
}

export async function getSessionImage(
  actor: AuthTokenPayload,
  id: number,
  kind:
    | "entry-overview"
    | "entry-vehicle"
    | "entry-plate"
    | "exit-overview"
    | "exit-vehicle"
    | "exit-plate"
) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);
  const columns = {
    "entry-overview": session.entry_overview_image_path,
    "entry-vehicle": session.entry_vehicle_image_path,
    "entry-plate": session.entry_plate_image_path,
    "exit-overview": session.exit_overview_image_path,
    "exit-vehicle": session.exit_vehicle_image_path,
    "exit-plate": session.exit_plate_image_path,
  };
  const relativePath = columns[kind];
  const absolutePath = relativePath ? resolveParkingImageAbsolutePath(relativePath) : null;
  if (!absolutePath) throw new ApiError("Rasm topilmadi", 404);
  return absolutePath;
}

export async function openBarrierForSession(
  actor: AuthTokenPayload,
  id: number,
  direction: "entry" | "exit"
) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);

  return openBarrier(session.org_id, direction);
}

export async function printReceiptForSession(actor: AuthTokenPayload, id: number) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);

  const organization = await db("tb_organizations")
    .select("name", "printer_ip")
    .where({ id: session.org_id })
    .first();

  if (!organization?.printer_ip) {
    return { success: false as const, reason: "printer_not_configured" as const };
  }

  const success = await printReceipt(organization.printer_ip, {
    orgName: organization.name,
    plateNumber: session.plate_number,
    enteredAt: new Date(session.entered_at),
    exitedAt: session.exited_at ? new Date(session.exited_at) : new Date(),
    durationMinutes: session.duration_minutes ?? 0,
    amount: Number(session.amount ?? 0),
    paymentMethod: session.payment_method,
    issuedAt: new Date(),
  });

  return { success };
}

const AWAITING_PAYMENT_OVERDUE_MINUTES = 5;

export async function listAwaitingPayment(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdFilter(actor, requestedOrgId);

  const query = sessionsBaseQuery(db)
    .where({ status: "awaiting_payment" })
    .orderBy("exited_at", "asc");
  if (orgId !== undefined) {
    query.andWhere({ org_id: orgId });
  }

  const sessions = await query;
  const now = Date.now();

  return sessions.map((session) => {
    const exitedAt = session.exited_at ? new Date(session.exited_at).getTime() : now;
    const overdueMinutes = (now - exitedAt) / 60000;
    return { ...withImageUrls(session), is_overdue: overdueMinutes > AWAITING_PAYMENT_OVERDUE_MINUTES };
  });
}

export async function confirmCashPayment(actor: AuthTokenPayload, id: number) {
  const existing = await findSessionOrFail(id);
  assertInScope(actor, existing);

  if (existing.status !== "awaiting_payment") {
    throw new ApiError("Sessiya to'lov kutish holatida emas", 400);
  }

  const operatorId = actor.role === "operator" || actor.role === "owner" ? actor.id : null;

  const result = await db.transaction(async (trx) => {
    const session = await sessionsBaseQuery(trx).where({ id }).forUpdate().first();
    if (!session) {
      throw new ApiError("Sessiya topilmadi", 404);
    }
    if (session.status !== "awaiting_payment") {
      throw new ApiError("Sessiya to'lov kutish holatida emas", 400);
    }

    await trx("tb_parking_sessions").where({ id }).update({
      status: "completed",
      payment_method: "cash",
      operator_id: operatorId,
      active_plate_key: null,
    });

    const [paymentId] = await trx("tb_payments").insert({
      org_id: session.org_id,
      session_id: id,
      amount: session.amount ?? 0,
      payment_method: "cash",
    });

    return {
      session: {
        ...session,
        status: "completed" as const,
        payment_method: "cash" as const,
        operator_id: operatorId,
      },
      payment: {
        id: paymentId,
        org_id: session.org_id,
        session_id: id,
        amount: session.amount ?? "0",
        payment_method: "cash" as const,
        paid_at: new Date(),
      },
    };
  });

  await openBarrierOrWarn(result.session.org_id, "exit", result.session.plate_number);

  const printResult = await printReceiptForSession(actor, id);
  if (!printResult.success) {
    console.warn(`Chek chop etilmadi (session #${id}): ${JSON.stringify(printResult)}`);
  }

  emitExitCompleted(result.session.org_id, {
    plateNumber: result.session.plate_number,
    amount: Number(result.session.amount),
  });

  await logActivity(actor.id, "parking.cash_payment_confirmed", "session", id, {
    plateNumber: result.session.plate_number,
    amount: Number(result.session.amount),
    actorId: actor.id,
  });

  return result;
}

export async function updateSessionPaymentMethod(
  actor: AuthTokenPayload,
  id: number,
  paymentMethod: "cash" | "online"
) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);

  if (session.status !== "completed") {
    throw new ApiError("Sessiya hali yopilmagan", 400);
  }

  await db("tb_parking_sessions").where({ id }).update({ payment_method: paymentMethod });

  return sessionsBaseQuery(db).where({ id }).first();
}

export async function forceCloseSession(
  actor: AuthTokenPayload,
  id: number,
  input: { exited_at?: string; amount?: number; payment_method?: "cash" | "online" }
) {
  const session = await findSessionOrFail(id);
  assertInScope(actor, session);

  let exitedAt: Date;
  if (input.exited_at !== undefined) {
    const parsed = new Date(input.exited_at);
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError("exited_at formati noto'g'ri", 400);
    }
    exitedAt = parsed;
  } else {
    exitedAt = new Date();
  }

  const enteredAt = new Date(session.entered_at);
  if (exitedAt.getTime() < enteredAt.getTime()) {
    throw new ApiError("exited_at entered_at dan oldin bo'lishi mumkin emas", 400);
  }

  if (input.amount !== undefined && (typeof input.amount !== "number" || input.amount < 0)) {
    throw new ApiError("amount manfiy bo'lishi mumkin emas", 400);
  }

  if (
    input.payment_method !== undefined &&
    input.payment_method !== "cash" &&
    input.payment_method !== "online"
  ) {
    throw new ApiError("payment_method 'cash' yoki 'online' bo'lishi kerak", 400);
  }

  const operatorId = actor.role === "operator" || actor.role === "owner" ? actor.id : null;

  const result = await db.transaction(async (trx) => {
    const lockedSession = await sessionsBaseQuery(trx).where({ id }).forUpdate().first();
    if (!lockedSession) {
      throw new ApiError("Sessiya topilmadi", 404);
    }
    if (lockedSession.status !== "active") {
      throw new ApiError("Sessiya allaqachon yopilgan", 400);
    }

    const durationMinutes = calculateDurationMinutes(new Date(lockedSession.entered_at), exitedAt);

    let amount: number;
    if (input.amount !== undefined) {
      amount = input.amount;
    } else if (lockedSession.session_source !== "regular") {
      amount = 0;
    } else {
      const intervalsSnapshot = parseIntervalsSnapshot(lockedSession.tariff_intervals_snapshot);
      if (intervalsSnapshot) {
        amount = calculateAmount(durationMinutes, 0, 0, intervalsSnapshot);
      } else if (lockedSession.tariff_price_per_hour !== null) {
        const pricePerHour = Number(lockedSession.tariff_price_per_hour);
        const gracePeriodMinutes = lockedSession.tariff_grace_period_minutes ?? 0;
        amount = calculateAmount(durationMinutes, pricePerHour, gracePeriodMinutes);
      } else {
        const tariff = await findTariff(trx, lockedSession.org_id);
        amount = calculateAmount(durationMinutes, Number(tariff.price_per_hour), tariff.grace_period_minutes);
      }
    }

    const sessionUpdates: Record<string, unknown> = {
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount,
      status: "completed",
      exit_method: "forced",
      operator_id: operatorId,
      active_plate_key: null,
    };
    if (lockedSession.session_source === "regular") {
      sessionUpdates.payment_method = input.payment_method ?? "cash";
    }

    await trx("tb_parking_sessions").where({ id }).update(sessionUpdates);

    const [paymentId] = await trx("tb_payments").insert({
      org_id: lockedSession.org_id,
      session_id: id,
      amount,
      payment_method: "cash",
    });

    const updatedSession = await sessionsBaseQuery(trx).where({ id }).first();

    return {
      session: updatedSession,
      payment: {
        id: paymentId,
        org_id: lockedSession.org_id,
        session_id: id,
        amount: String(amount),
        payment_method: "cash" as const,
        paid_at: exitedAt,
      },
    };
  });

  const orgId = result.session!.org_id;
  const plateNumber = result.session!.plate_number;

  await openBarrierOrWarn(orgId, "exit", plateNumber);

  const printResult = await printReceiptForSession(actor, id);
  if (!printResult.success) {
    console.warn(`Chek chop etilmadi (session #${id}): ${JSON.stringify(printResult)}`);
  }

  emitExitCompleted(orgId, {
    plateNumber,
    amount: Number(result.session!.amount),
  });

  return result;
}

export async function getCapacity(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);

  const organization = await db("tb_organizations").select("total_capacity").where({ id: orgId }).first();
  const [{ count }] = await applyInsideSessionsFilter(
    db("tb_parking_sessions").where({ org_id: orgId })
  ).count<{ count: string }[]>("id as count");

  const occupied = Number(count);
  const total: number | null = organization?.total_capacity ?? null;
  const available = total === null ? null : Math.max(0, total - occupied);

  return { occupied, total, available };
}

export async function clearAllActiveSessions(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);

  return db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    const now = new Date();
    const clearedCount = await trx("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereIn("status", [...INSIDE_SESSION_STATUSES])
      .update({
        status: "completed",
        exited_at: trx.raw("COALESCE(exited_at, ?)", [now]),
        duration_minutes: trx.raw("COALESCE(duration_minutes, 0)"),
        amount: trx.raw("COALESCE(amount, 0)"),
        active_plate_key: null,
      });

    await trx("tb_activity_logs").insert({
      actor_id: actor.id,
      action: "parking.test_sessions_cleared",
      target_type: "organization",
      target_id: orgId,
      details: JSON.stringify({ orgId, cleared: clearedCount }),
    });

    return { cleared: clearedCount };
  });
}
