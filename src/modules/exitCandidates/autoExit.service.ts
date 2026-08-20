import type { Knex } from "knex";
import { db } from "@/config/db";
import {
  getOrgTodayDate,
  getOrgTodayRange,
  markClinicDiscountUsed,
  normalizePlate,
} from "@/modules/medplus/medplus.service";
import { calculateDurationMinutes, displayPlateNumber } from "@/modules/parking/parking.service";
import { INSIDE_SESSION_STATUSES } from "@/modules/parking/sessionStatus";
import { BarrierStatus } from "@/modules/relay/relay.service";
import { ledService } from "@/modules/led/led.service";
import { RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS } from "@/modules/webhook/webhookRules";
import { emitExitCompleted, emitRelayFailed } from "@/websocket/socketServer";
import { recordBarrierAttempt } from "./exitCandidates.service";

export type AutoExitReason = "inpatient" | "vip" | "clinic_discount_100";

const FULL_DISCOUNT_PERCENT = 100;

function completeAutoExitLed(plateNumber: string): void {
  try {
    void ledService.showPlateOnly(plateNumber).catch((error) => {
      console.error("LED_PLATE_FAILED", error);
    });
  } catch (error) {
    console.error("LED_PLATE_FAILED", error);
  }
  try {
    ledService.scheduleReturnToClock();
  } catch (error) {
    console.error("LED_CLOCK_SCHEDULE_FAILED", error);
  }
}

interface AutoExitEligibility {
  eligible: boolean;
  reason?: AutoExitReason;
  clinicDiscountId?: number;
}

interface AutoExitSession {
  id: number;
  org_id: number;
  plate_number: string | null;
  entered_at: Date;
  status: "active" | "awaiting_payment" | "completed";
  session_source: "regular" | "subscription" | "vip";
}

export interface AutoExitResult {
  sessionId: number;
  plateNumber: string;
  reason: AutoExitReason;
  barrierStatus: BarrierStatus;
}

export async function resolveAutoExitEligibility(
  orgId: number,
  plateNumber: string,
  executor: Knex = db
): Promise<AutoExitEligibility> {
  const normalized = normalizePlate(plateNumber);
  if (!normalized) return { eligible: false };

  const organization = await executor("tb_organizations").select("timezone").where({ id: orgId }).first();
  if (!organization) return { eligible: false };

  const inpatient = await executor("tb_inpatient_vehicles")
    .select("id")
    .where({ org_id: orgId, plate_number: normalized, status: "active" })
    .andWhere("valid_until", ">=", getOrgTodayDate(organization.timezone))
    .first();
  if (inpatient) return { eligible: true, reason: "inpatient" };

  const vip = await executor("tb_vip_vehicles")
    .select("id")
    .where({ org_id: orgId, plate_number: normalized })
    .first();
  if (vip) return { eligible: true, reason: "vip" };

  const todayRange = getOrgTodayRange(organization.timezone);
  const fullDiscount = await executor("tb_clinic_discounts")
    .select("id")
    .where({
      org_id: orgId,
      plate_number: normalized,
      status: "pending",
      discount_percent: FULL_DISCOUNT_PERCENT,
    })
    .andWhere("created_at", ">=", todayRange.start)
    .andWhere("created_at", "<", todayRange.end)
    .orderBy("created_at", "desc")
    .first();
  if (fullDiscount) {
    return { eligible: true, reason: "clinic_discount_100", clinicDiscountId: fullDiscount.id };
  }

  return { eligible: false };
}

export async function wasRecentlyAutoExited(
  orgId: number,
  plateNumber: string,
  executor: Knex = db
): Promise<boolean> {
  const normalized = normalizePlate(plateNumber);
  if (!normalized) return false;

  const recent = await executor("tb_activity_logs as log")
    .join("tb_parking_sessions as session", "session.id", "log.target_id")
    .select("log.id")
    .where({
      "log.action": "auto_exit_no_operator",
      "log.target_type": "session",
      "session.org_id": orgId,
      "session.plate_number": normalized,
    })
    .andWhere("log.created_at", ">=", new Date(Date.now() - RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS))
    .first();

  return Boolean(recent);
}

async function findAutoExitSession(
  orgId: number,
  plateNumber: string,
  executor: Knex
): Promise<AutoExitSession | undefined> {
  return executor<AutoExitSession>("tb_parking_sessions")
    .select("id", "org_id", "plate_number", "entered_at", "status", "session_source")
    .where({ org_id: orgId, plate_number: plateNumber })
    .whereIn("status", [...INSIDE_SESSION_STATUSES])
    .orderByRaw("CASE WHEN status = 'active' THEN 0 ELSE 1 END")
    .orderBy("entered_at", "desc")
    .first();
}

export async function performAutoExit(input: {
  orgId: number;
  sessionId: number;
  webhookEventId: number;
  reason: AutoExitReason;
  clinicDiscountId?: number;
}): Promise<AutoExitResult | null> {
  const transactionResult = await db.transaction(async (trx) => {
    await trx("tb_organizations").where({ id: input.orgId }).forUpdate().first();

    const session = await trx<AutoExitSession>("tb_parking_sessions")
      .select("id", "org_id", "plate_number", "entered_at", "status", "session_source")
      .where({ id: input.sessionId, org_id: input.orgId })
      .forUpdate()
      .first();
    if (!session || !INSIDE_SESSION_STATUSES.includes(session.status as "active" | "awaiting_payment")) {
      return null;
    }

    const exitedAt = new Date();
    const durationMinutes = calculateDurationMinutes(new Date(session.entered_at), exitedAt);

    await trx("tb_parking_sessions").where({ id: session.id, org_id: input.orgId }).update({
      status: "completed",
      exited_at: exitedAt,
      duration_minutes: durationMinutes,
      amount: 0,
      exit_method: "auto",
      operator_id: null,
      active_plate_key: null,
    });

    if (input.reason === "clinic_discount_100" && input.clinicDiscountId !== undefined) {
      await markClinicDiscountUsed(input.clinicDiscountId, session.id, exitedAt, trx);
    }

    await trx("tb_webhook_events").where({ id: input.webhookEventId, org_id: input.orgId }).update({
      processing_result: "auto_exit_completed",
      processing_reason: input.reason,
      session_id: session.id,
      processed_at: trx.fn.now(),
    });

    await trx("tb_activity_logs").insert({
      actor_id: null,
      action: "auto_exit_no_operator",
      target_type: "session",
      target_id: session.id,
      details: JSON.stringify({
        orgId: input.orgId,
        sessionId: session.id,
        plateNumber: displayPlateNumber(session.plate_number),
        reason: input.reason,
        webhookEventId: input.webhookEventId,
      }),
    });

    return { session, durationMinutes };
  });

  if (!transactionResult) return null;

  const { session, durationMinutes } = transactionResult;
  const plateNumber = displayPlateNumber(session.plate_number);

  const barrierStatus = await recordBarrierAttempt({
    actorId: null,
    orgId: input.orgId,
    candidateId: null,
    sessionId: session.id,
    retryAttempt: false,
  });

  if (barrierStatus === "failed") {
    emitRelayFailed(input.orgId, {
      direction: "exit",
      plateNumber,
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }

  emitExitCompleted(input.orgId, {
    orgId: input.orgId,
    sessionId: session.id,
    plateNumber,
    amount: 0,
    paymentMethod: null,
    barrierStatus,
    sessionSource: session.session_source,
    durationMinutes,
  });

  completeAutoExitLed(plateNumber);

  return { sessionId: session.id, plateNumber, reason: input.reason, barrierStatus };
}

export async function tryAutoExit(input: {
  orgId: number;
  webhookEventId: number;
  plateNumber: string | null;
}): Promise<AutoExitResult | null> {
  if (!input.plateNumber) return null;

  const eligibility = await resolveAutoExitEligibility(input.orgId, input.plateNumber);
  if (!eligibility.eligible || !eligibility.reason) return null;

  const session = await findAutoExitSession(input.orgId, input.plateNumber, db);
  if (!session) return null;

  return performAutoExit({
    orgId: input.orgId,
    sessionId: session.id,
    webhookEventId: input.webhookEventId,
    reason: eligibility.reason,
    clinicDiscountId: eligibility.clinicDiscountId,
  });
}
