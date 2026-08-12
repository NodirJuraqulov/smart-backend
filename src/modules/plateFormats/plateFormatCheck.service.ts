import { db } from "@/config/db";
import { processEntryWebhook } from "@/modules/entryCandidates/entryCandidates.service";
import { createExitCandidate } from "@/modules/exitCandidates/exitCandidates.service";
import { NormalizedCameraEvent } from "@/modules/webhook/parsers/normalizedCameraEvent";
import { updateWebhookEventOutcome } from "@/modules/webhook/webhookIdempotency";
import { isFuzzyPlateMatch } from "@/modules/webhook/webhookRules";
import {
  emitPlateNotRecognizedForExit,
} from "@/websocket/socketServer";
import { isValidPlateFormat, PlateFormat } from "./plateFormats.service";

export const PLATE_FORMAT_CHECK_WINDOW_MS = 3000;
export const PLATE_FORMAT_CHECK_MAX_ATTEMPTS = 3;

type Direction = "entry" | "exit";

interface PlateFormatCheckRow {
  id: number;
  org_id: number;
  direction: Direction;
  device_id: string;
  reference_plate: string | null;
  last_detected_plate: string | null;
  last_webhook_event_id: number;
  attempts: number;
  status: "pending" | "finalizing";
  first_seen_at: Date;
  deadline_at: Date;
}

interface WebhookEventRow {
  id: number;
  org_id: number;
  direction: Direction;
  confidence: string | number | null;
  camera_event_at: Date | null;
}

interface ValidationInput {
  orgId: number;
  direction: Direction;
  deviceId: string;
  detectedPlate: string | null;
  webhookEventId: number;
  decision?: { enabled: boolean; valid: boolean };
}

type FinalizationResult =
  | { status: "cancelled" }
  | {
      status: "finalized";
      candidateId: number;
      candidateCreated: boolean;
      candidateCoalesced: boolean;
      suggestedPlate: string | null;
    };

export type PlateFormatValidationResult =
  | { status: "proceed" }
  | { status: "waiting"; attempts: number; deadlineAt: Date }
  | FinalizationResult;

const timers = new Map<number, NodeJS.Timeout>();
const locks = new Map<string, Promise<void>>();

function observationLockKey(orgId: number, direction: Direction, deviceId: string): string {
  return `${orgId}:${direction}:${deviceId}`;
}

async function withObservationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function matchesObservation(
  check: Pick<PlateFormatCheckRow, "reference_plate" | "last_detected_plate">,
  detectedPlate: string | null
): boolean {
  if (check.reference_plate === detectedPlate || check.last_detected_plate === detectedPlate) {
    return true;
  }
  if (!detectedPlate) return false;
  return (
    isFuzzyPlateMatch(detectedPlate, check.reference_plate) ||
    isFuzzyPlateMatch(detectedPlate, check.last_detected_plate)
  );
}

function selectMatchingCheck(
  checks: PlateFormatCheckRow[],
  detectedPlate: string | null
): PlateFormatCheckRow | undefined {
  const exact = checks.find((check) => check.reference_plate === detectedPlate);
  if (exact) return exact;
  const fuzzy = checks.filter((check) => matchesObservation(check, detectedPlate));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

async function validationConfiguration(orgId: number): Promise<{
  enabled: boolean;
  formats: PlateFormat[];
}> {
  const organization = await db("tb_organizations")
    .select("plate_format_validation_enabled")
    .where({ id: orgId })
    .first();
  if (!organization?.plate_format_validation_enabled) return { enabled: false, formats: [] };
  const formats = await db<PlateFormat>("tb_plate_formats")
    .where({ org_id: orgId, is_active: true })
    .orderBy("id", "asc");
  return { enabled: true, formats };
}

export async function getPlateFormatValidationDecision(
  orgId: number,
  detectedPlate: string | null
): Promise<{ enabled: boolean; valid: boolean }> {
  const configuration = await validationConfiguration(orgId);
  return {
    enabled: configuration.enabled,
    valid:
      !configuration.enabled ||
      isValidPlateFormat(detectedPlate ?? "", configuration.formats),
  };
}

function clearTimer(checkId: number): void {
  const timer = timers.get(checkId);
  if (timer) clearTimeout(timer);
  timers.delete(checkId);
}

function scheduleCheck(checkId: number, deadlineAt: Date): void {
  clearTimer(checkId);
  const delay = Math.max(0, deadlineAt.getTime() - Date.now());
  const timer = setTimeout(() => {
    timers.delete(checkId);
    finalizePlateFormatCheck(checkId).catch((error) => {
      console.error(`Davlat raqami format tekshiruvi #${checkId} yakunlanmadi:`, error);
      retryPlateFormatCheck(checkId).catch((retryError) => {
        console.error(`Davlat raqami format tekshiruvi #${checkId} qayta rejalashtirilmadi:`, retryError);
      });
    });
  }, delay);
  timer.unref();
  timers.set(checkId, timer);
}

async function retryPlateFormatCheck(checkId: number): Promise<void> {
  const check = await db<PlateFormatCheckRow>("tb_plate_format_checks")
    .select("id", "deadline_at")
    .where({ id: checkId })
    .first();
  if (check) scheduleCheck(check.id, new Date(Date.now() + 500));
}

async function removeCheck(checkId: number): Promise<void> {
  clearTimer(checkId);
  await db("tb_plate_format_checks").where({ id: checkId }).del();
}

async function finalizeCheck(check: PlateFormatCheckRow): Promise<FinalizationResult> {
  const claimed = await db("tb_plate_format_checks")
    .where({ id: check.id, status: "pending" })
    .update({ status: "finalizing", updated_at: db.fn.now() });
  if (claimed !== 1) return { status: "cancelled" };
  try {
    const current = await db<PlateFormatCheckRow>("tb_plate_format_checks")
      .where({ id: check.id, status: "finalizing" })
      .first();
    if (!current) return { status: "cancelled" };
    const configuration = await validationConfiguration(current.org_id);
    if (
      !configuration.enabled ||
      isValidPlateFormat(current.last_detected_plate ?? "", configuration.formats)
    ) {
      await removeCheck(current.id);
      return { status: "cancelled" };
    }

    const webhookEvent = await db<WebhookEventRow>("tb_webhook_events")
      .where({
        id: current.last_webhook_event_id,
        org_id: current.org_id,
        direction: current.direction,
      })
      .first();
    if (!webhookEvent) {
      await removeCheck(current.id);
      return { status: "cancelled" };
    }

    const confidence = webhookEvent.confidence === null ? null : Number(webhookEvent.confidence);
    if (current.direction === "exit") {
      const result = await createExitCandidate({
        orgId: current.org_id,
        webhookEventId: webhookEvent.id,
        detectedPlate: null,
        suggestedPlate: current.last_detected_plate,
        confidence,
      });
      if (result.skipped) {
        await removeCheck(current.id);
        return { status: "cancelled" };
      }
      if (result.created) {
        emitPlateNotRecognizedForExit(current.org_id, {
          plateNumber: null,
          suggestedPlate: current.last_detected_plate,
          eventId: webhookEvent.id,
          candidateId: result.candidate.id,
          message: "Davlat raqami formati aniqlanmadi — operator tekshiruvi kerak",
        });
      }
      await removeCheck(current.id);
      return {
        status: "finalized",
        candidateId: result.candidate.id,
        candidateCreated: result.created,
        candidateCoalesced: result.coalesced,
        suggestedPlate: current.last_detected_plate,
      };
    }

    const event: NormalizedCameraEvent = {
      plateNumber: null,
      confidence,
      timestamp: webhookEvent.camera_event_at,
      direction: "entry",
      cameraBrand: "format_validation",
    };
    const result = await processEntryWebhook({
      orgId: current.org_id,
      webhookEventId: webhookEvent.id,
      event,
      suggestedPlate: current.last_detected_plate,
    });
    if (!("candidateId" in result) || result.candidateId === undefined) {
      await removeCheck(current.id);
      return { status: "cancelled" };
    }
    await removeCheck(current.id);
    return {
      status: "finalized",
      candidateId: result.candidateId,
      candidateCreated: result.candidateCreated,
      candidateCoalesced: result.candidateCoalesced,
      suggestedPlate: current.last_detected_plate,
    };
  } catch (error) {
    await db("tb_plate_format_checks")
      .where({ id: check.id, status: "finalizing" })
      .update({ status: "pending", updated_at: db.fn.now() });
    throw error;
  }
}

async function finalizePlateFormatCheck(checkId: number): Promise<FinalizationResult> {
  const check = await db<PlateFormatCheckRow>("tb_plate_format_checks")
    .where({ id: checkId })
    .first();
  if (!check) return { status: "cancelled" };
  const key = observationLockKey(check.org_id, check.direction, check.device_id);
  return withObservationLock(key, async () => {
    const current = await db<PlateFormatCheckRow>("tb_plate_format_checks")
      .where({ id: checkId })
      .first();
    if (!current) return { status: "cancelled" };
    if (current.status === "pending" && new Date(current.deadline_at).getTime() > Date.now()) {
      scheduleCheck(current.id, new Date(current.deadline_at));
      return { status: "cancelled" };
    }
    return finalizeCheck(current);
  });
}

export async function validateOrTrackPlateFormat(
  input: ValidationInput
): Promise<PlateFormatValidationResult> {
  const decision = input.decision ?? await getPlateFormatValidationDecision(input.orgId, input.detectedPlate);
  if (!decision.enabled) return { status: "proceed" };
  const valid = decision.valid;
  const key = observationLockKey(input.orgId, input.direction, input.deviceId);
  return withObservationLock(key, async () => {
    if (valid) {
      await db.transaction(async (trx) => {
        await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();
        const checks = await trx<PlateFormatCheckRow>("tb_plate_format_checks")
          .where({
            org_id: input.orgId,
            direction: input.direction,
            device_id: input.deviceId,
          })
          .forUpdate();
        const matching = selectMatchingCheck(checks, input.detectedPlate);
        if (matching) {
          await trx("tb_plate_format_checks").where({ id: matching.id }).del();
          clearTimer(matching.id);
        }
      });
      return { status: "proceed" };
    }

    const tracked = await db.transaction(async (trx) => {
      await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();
      const checks = await trx<PlateFormatCheckRow>("tb_plate_format_checks")
        .where({
          org_id: input.orgId,
          direction: input.direction,
          device_id: input.deviceId,
        })
        .forUpdate();
      const matching = selectMatchingCheck(checks, input.detectedPlate);
      if (matching?.status === "finalizing") {
        return {
          check: matching,
          shouldFinalize: false,
        };
      }
      const now = new Date();
      if (matching) {
        const attempts = Number(matching.attempts) + 1;
        await trx("tb_plate_format_checks").where({ id: matching.id }).update({
          last_detected_plate: input.detectedPlate,
          last_webhook_event_id: input.webhookEventId,
          attempts,
          updated_at: trx.fn.now(),
        });
        const updated = {
          ...matching,
          last_detected_plate: input.detectedPlate,
          last_webhook_event_id: input.webhookEventId,
          attempts,
        };
        return {
          check: updated,
          shouldFinalize:
            attempts >= PLATE_FORMAT_CHECK_MAX_ATTEMPTS ||
            now.getTime() >= new Date(matching.deadline_at).getTime(),
        };
      }
      const deadlineAt = new Date(now.getTime() + PLATE_FORMAT_CHECK_WINDOW_MS);
      const [checkId] = await trx("tb_plate_format_checks").insert({
        org_id: input.orgId,
        direction: input.direction,
        device_id: input.deviceId,
        reference_plate: input.detectedPlate,
        last_detected_plate: input.detectedPlate,
        last_webhook_event_id: input.webhookEventId,
        attempts: 1,
        first_seen_at: now,
        deadline_at: deadlineAt,
      });
      return {
        check: {
          id: checkId,
          org_id: input.orgId,
          direction: input.direction,
          device_id: input.deviceId,
          reference_plate: input.detectedPlate,
          last_detected_plate: input.detectedPlate,
          last_webhook_event_id: input.webhookEventId,
          attempts: 1,
          status: "pending" as const,
          first_seen_at: now,
          deadline_at: deadlineAt,
        },
        shouldFinalize: false,
      };
    });

    if (tracked.shouldFinalize) return finalizeCheck(tracked.check);
    scheduleCheck(tracked.check.id, new Date(tracked.check.deadline_at));
    await updateWebhookEventOutcome(input.webhookEventId, {
      processingResult: "plate_format_waiting",
      processingReason: "invalid_plate_format",
    });
    return {
      status: "waiting",
      attempts: Number(tracked.check.attempts),
      deadlineAt: new Date(tracked.check.deadline_at),
    };
  });
}

export async function resumePlateFormatChecks(): Promise<void> {
  await db("tb_plate_format_checks")
    .where({ status: "finalizing" })
    .update({ status: "pending", updated_at: db.fn.now() });
  const checks = await db<PlateFormatCheckRow>("tb_plate_format_checks").select("id", "deadline_at");
  for (const check of checks) scheduleCheck(check.id, new Date(check.deadline_at));
}

export function pausePlateFormatCheckTimersForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

export async function clearPlateFormatChecksForTests(orgId?: number): Promise<void> {
  pausePlateFormatCheckTimersForTests();
  const query = db("tb_plate_format_checks");
  if (orgId !== undefined) query.where({ org_id: orgId });
  await query.del();
}
