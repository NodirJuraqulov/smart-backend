import type { Knex } from "knex";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdFilter, resolveOrgIdRequired } from "@/utils/orgScope";
import { saveParkingImage } from "@/utils/imageStorage";
import { detectPlate, OcrResult } from "@/services/ocr.service";
import { emitDetectionFailed, emitParkingEntry, emitParkingExit } from "@/websocket/socketServer";

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
  status: "active" | "completed";
  entry_method: "auto" | "manual";
  exit_method: "auto" | "manual" | "forced" | null;
  image_entry: string | null;
  image_exit: string | null;
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

const MAX_CAPTURED_AT_AGE_MS = 24 * 60 * 60 * 1000;

function resolveCapturedAt(capturedAt: string | undefined): Date {
  if (!capturedAt) {
    return new Date();
  }

  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`captured_at formati noto'g'ri ("${capturedAt}") — hozirgi vaqt ishlatildi`);
    return new Date();
  }

  const now = Date.now();
  if (parsed.getTime() > now) {
    console.warn(`captured_at kelajakdagi sana ("${capturedAt}") — hozirgi vaqt ishlatildi`);
    return new Date();
  }

  if (now - parsed.getTime() > MAX_CAPTURED_AT_AGE_MS) {
    console.warn(`captured_at 24 soatdan eski ("${capturedAt}") — hozirgi vaqt ishlatildi`);
    return new Date();
  }

  return parsed;
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
    return calculateIntervalAmount(durationMinutes, intervals);
  }
  if (durationMinutes <= gracePeriodMinutes) {
    return 0;
  }
  return Math.ceil(durationMinutes / 60) * pricePerHour;
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

  const [{ count }] = await db("tb_parking_sessions")
    .where({ org_id: orgId, status: "active" })
    .count<{ count: string }[]>("id as count");

  if (Number(count) >= organization.total_capacity) {
    throw new ApiError("Stoyanka to'liq, bo'sh joy yo'q", 400, { reason: "parking_full" });
  }
}

async function assertNoActiveSessionForPlate(orgId: number, plateNumber: string) {
  const existing = await sessionsBaseQuery(db)
    .where({ org_id: orgId, plate_number: plateNumber, status: "active" })
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
        .where({ org_id: input.org_id, plate_number: input.plate_number, status: "active" })
        .first();
      throw new ApiError("Bu mashina hali stoyankada!", 409, { existing_session: existing });
    }
    throw err;
  }
}

async function findTariff(executor: Knex, orgId: number) {
  const tariff = await executor<TariffRecord>("tb_tariffs").where({ org_id: orgId }).first();
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

async function captureAndDetect(
  imageBase64: string | undefined
): Promise<{ imagePath: string | null; ocrResult: OcrResult }> {
  if (!imageBase64) {
    return {
      imagePath: null,
      ocrResult: { detected: false, plate: null, confidence: 0, candidateFound: false },
    };
  }

  const ocrResult = await detectPlate(imageBase64);
  if (!ocrResult.candidateFound) {
    return { imagePath: null, ocrResult };
  }

  const imagePath = await saveParkingImage(imageBase64);
  return { imagePath, ocrResult };
}

export async function entryAuto(
  orgId: number,
  operatorId: number | null,
  image: string | undefined,
  capturedAt?: string
) {
  await assertWithinWorkHours(orgId);
  await assertCapacityAvailable(orgId);

  const enteredAt = resolveCapturedAt(capturedAt);
  const { imagePath, ocrResult } = await captureAndDetect(image);

  if (!ocrResult.candidateFound) {
    return { detected: false as const, reason: "no_candidate" as const, message: "Nomer aniqlanmadi" };
  }

  if (!ocrResult.detected || !ocrResult.plate) {
    console.warn(`OCR: nomer-kandidat topildi, lekin o'qib bo'lmadi (org_id: ${orgId}, entry)`);
    emitParkingEntry(orgId, { session: null, detected: false });
    emitDetectionFailed(orgId, { type: "entry", image_url: imagePath });
    return { detected: false as const, reason: "ocr_failed" as const, message: "Nomer aniqlanmadi" };
  }

  await assertNoActiveSessionForPlate(orgId, ocrResult.plate);
  const sessionSource = await resolveSessionSource(orgId, ocrResult.plate);
  const pricing = await resolveEntryPricing(orgId, sessionSource);

  const session = await insertActiveSession({
    org_id: orgId,
    plate_number: ocrResult.plate,
    entry_method: "auto",
    image_entry: imagePath,
    operator_id: operatorId,
    entered_at: enteredAt,
    session_source: sessionSource,
    tariff_price_per_hour: pricing.tariff_price_per_hour,
    tariff_grace_period_minutes: pricing.tariff_grace_period_minutes,
    tariff_intervals_snapshot: pricing.tariff_intervals_snapshot,
  });

  emitParkingEntry(orgId, { session, detected: true });

  return { detected: true as const, session, confidence: ocrResult.confidence };
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

  return insertActiveSession({
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
}

export async function exitAuto(
  orgId: number,
  operatorId: number | null,
  image: string | undefined,
  capturedAt?: string,
  paymentMethod: "cash" | "online" = "cash"
) {
  const exitedAt = resolveCapturedAt(capturedAt);
  const { imagePath, ocrResult } = await captureAndDetect(image);

  if (!ocrResult.candidateFound) {
    return { detected: false as const, reason: "no_candidate" as const, message: "Nomer aniqlanmadi" };
  }

  if (!ocrResult.detected || !ocrResult.plate) {
    console.warn(`OCR: nomer-kandidat topildi, lekin o'qib bo'lmadi (org_id: ${orgId}, exit)`);
    emitParkingExit(orgId, { session: null, payment: null, detected: false });
    emitDetectionFailed(orgId, { type: "exit", image_url: imagePath });
    return { detected: false as const, reason: "ocr_failed" as const, message: "Nomer aniqlanmadi" };
  }

  const result = await completeSession(
    orgId,
    ocrResult.plate,
    operatorId,
    "auto",
    imagePath,
    exitedAt,
    paymentMethod
  );
  emitParkingExit(orgId, { session: result.session, payment: result.payment, detected: true });

  return { detected: true as const, ...result, confidence: ocrResult.confidence };
}

export async function exitManual(
  actor: AuthTokenPayload,
  input: { org_id?: number; plate_number: string; payment_method?: "cash" | "online" }
) {
  const orgId = resolveOrgIdRequired(actor, input.org_id);
  const operatorId = actor.role === "operator" || actor.role === "owner" ? actor.id : null;
  return completeSession(
    orgId,
    input.plate_number,
    operatorId,
    "manual",
    null,
    new Date(),
    input.payment_method ?? "cash"
  );
}

export async function listActive(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdFilter(actor, requestedOrgId);
  const query = sessionsBaseQuery(db)
    .where({ status: "active" })
    .orderBy("entered_at", "desc");
  if (orgId !== undefined) {
    query.andWhere({ org_id: orgId });
  }
  return query;
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

  return {
    sessions,
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
  return session;
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

  return db.transaction(async (trx) => {
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
}

export async function getCapacity(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);

  const organization = await db("tb_organizations").select("total_capacity").where({ id: orgId }).first();
  const [{ count }] = await db("tb_parking_sessions")
    .where({ org_id: orgId, status: "active" })
    .count<{ count: string }[]>("id as count");

  const occupied = Number(count);
  const total: number | null = organization?.total_capacity ?? null;
  const available = total === null ? null : Math.max(0, total - occupied);

  return { occupied, total, available };
}

export async function clearAllActiveSessions() {
  const clearedCount = await db("tb_parking_sessions").where({ status: "active" }).update({
    status: "completed",
    exited_at: new Date(),
    duration_minutes: 0,
    amount: 0,
    active_plate_key: null,
  });

  return { cleared: clearedCount };
}
