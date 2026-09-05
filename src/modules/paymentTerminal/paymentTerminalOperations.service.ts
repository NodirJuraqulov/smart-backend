import type { Knex } from "knex";
import { db } from "@/config/db";
import { ledService } from "@/modules/led/led.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { telegramService } from "@/modules/telegram/telegram.service";
import { getUserById } from "@/modules/auth/auth.service";
import { formatDuration, printReceipt } from "@/modules/printer/printer.service";
import { ApiError } from "@/utils/ApiError";
import type { PaymentMethod } from "@/modules/payment/paymentMethod";
import {
  emitExitCompleted,
  emitExitPaymentDeclined,
  emitRelayFailed,
} from "@/websocket/socketServer";
import { paymentTerminalManager } from "./PaymentTerminalManager";
import type { PaymentTerminalLease } from "./PaymentTerminalManager";
import type { FinResult, PaymentResult, PaymentTerminal } from "./PaymentTerminal.interface";
import { somToMinor } from "./VendotekVTK";

const MAX_OPERATION_NUMBER = 99_999_999;
const FIN_ATTEMPTS = 3;
const FIN_RETRY_DELAY_MS = 5_000;

function displayPlateNumber(plateNumber: string | null | undefined): string {
  return plateNumber || "Noma'lum";
}

export type PaymentTerminalOperationStatus =
  | "PENDING"
  | "APPROVED"
  | "DECLINED"
  | "TIMEOUT"
  | "FIN_CONFIRMED"
  | "FIN_FAILED"
  | "ERROR"
  | "ABORTED"
  | "STALE_IGNORED"
  | "ORPHANED";

interface PaymentTerminalOperationRow {
  id: number;
  org_id: number;
  session_id: number | null;
  candidate_id: number | null;
  operator_id: number | null;
  operation_number: string;
  requested_amount_som: string | number;
  sent_amount_minor: number;
  approved_amount_som: string | number | null;
  status: PaymentTerminalOperationStatus;
  raw_vrp_request_hex: string | null;
  raw_vrp_response_hex: string | null;
  raw_fin_request_hex: string | null;
  raw_fin_response_hex: string | null;
  error_message: string | null;
  created_at: Date;
}

interface CardPaymentSessionRow {
  id: number;
  org_id: number;
  plate_number: string | null;
  entered_at: Date;
  exited_at: Date | null;
  duration_minutes: number | null;
  amount: string | number | null;
  status: "active" | "awaiting_payment" | "completed";
  session_source: "regular" | "subscription" | "vip";
  payment_method: PaymentMethod;
  exit_method: "auto" | "manual" | "forced" | "auto_closed_on_reentry" | "emergency" | null;
}

export interface CreatePaymentTerminalOperationInput {
  orgId: number;
  sessionId: number;
  candidateId: number | null;
  operatorId: number | null;
  amountSom: number;
}

export async function createPaymentTerminalOperation(
  trx: Knex.Transaction,
  input: CreatePaymentTerminalOperationInput
) {
  await trx("tb_organizations").select("id").where({ id: input.orgId }).forUpdate().first();
  const latest = await trx<PaymentTerminalOperationRow>("payment_terminal_operations")
    .select("operation_number")
    .where({ org_id: input.orgId })
    .orderBy("id", "desc")
    .forUpdate()
    .first();
  const current = latest ? Number(latest.operation_number) : 0;
  if (!Number.isSafeInteger(current) || current < 0 || current >= MAX_OPERATION_NUMBER) {
    throw new ApiError("Terminal operatsiya raqami chegaraga yetgan", 409);
  }
  const operationNumber = String(current + 1);
  const sentAmountMinor = somToMinor(input.amountSom);
  const [id] = await trx("payment_terminal_operations").insert({
    org_id: input.orgId,
    session_id: input.sessionId,
    candidate_id: input.candidateId,
    operator_id: input.operatorId,
    operation_number: operationNumber,
    requested_amount_som: input.amountSom,
    sent_amount_minor: sentAmountMinor,
    status: "PENDING",
  });
  return { id, operationNumber, sentAmountMinor };
}

function schedule(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function updateOperationWhileStatus(
  operationId: number,
  status: PaymentTerminalOperationStatus,
  updates: Partial<PaymentTerminalOperationRow>
): Promise<boolean> {
  const updated = await db("payment_terminal_operations")
    .where({ id: operationId, status })
    .update({ ...updates, updated_at: db.fn.now() });
  return updated > 0;
}

async function emitPaymentFailure(
  operation: PaymentTerminalOperationRow,
  reason: "declined" | "timeout",
  errorMessage: string | null
): Promise<void> {
  emitExitPaymentDeclined(operation.org_id, {
    orgId: operation.org_id,
    sessionId: operation.session_id,
    operationNumber: operation.operation_number,
    reason,
    errorMessage,
  });
  await db("tb_activity_logs").insert({
    actor_id: operation.operator_id,
    action: `payment_terminal.${reason}`,
    target_type: "session",
    target_id: operation.session_id,
    details: JSON.stringify({
      orgId: operation.org_id,
      operationNumber: operation.operation_number,
      errorMessage,
    }),
  });
}

async function completeManualCardPayment(
  operationId: number,
  rawFinRequestHex: string,
  rawFinResponseHex: string | null
): Promise<void> {
  const completed = await db.transaction(async (trx) => {
    const operation = await trx<PaymentTerminalOperationRow>("payment_terminal_operations")
      .where({ id: operationId })
      .forUpdate()
      .first();
    if (!operation) throw new ApiError("Terminal operatsiyasi topilmadi", 404);
    if (operation.session_id === null) throw new ApiError("Terminal operatsiyasida sessiya topilmadi", 409);
    const session = await trx<CardPaymentSessionRow>("tb_parking_sessions")
      .where({ id: operation.session_id, org_id: operation.org_id })
      .forUpdate()
      .first();
    if (!session) throw new ApiError("Sessiya topilmadi", 404);
    if (operation.status !== "APPROVED") return null;
    if (session.status !== "active") {
      await trx("payment_terminal_operations").where({ id: operationId, status: "APPROVED" }).update({
        status: "STALE_IGNORED",
        raw_fin_request_hex: rawFinRequestHex,
        raw_fin_response_hex: rawFinResponseHex,
        error_message: "Sessiya allaqachon boshqa usul bilan yopilgan",
        updated_at: trx.fn.now(),
      });
      await trx("tb_activity_logs").insert({
        actor_id: operation.operator_id,
        action: "payment_terminal.manual_reconciliation_required",
        target_type: "session",
        target_id: session.id,
        details: JSON.stringify({
          orgId: operation.org_id,
          operationNumber: operation.operation_number,
          reason: "stale_card_payment",
          sessionStatus: session.status,
        }),
      });
      return null;
    }
    const approvedAmount = Number(operation.approved_amount_som);
    const paidAt = new Date();
    const durationMinutes = Math.max(
      0,
      Math.ceil((paidAt.getTime() - new Date(session.entered_at).getTime()) / 60_000)
    );
    await trx("payment_terminal_operations").where({ id: operationId, status: "APPROVED" }).update({
      status: "FIN_CONFIRMED",
      raw_fin_request_hex: rawFinRequestHex,
      raw_fin_response_hex: rawFinResponseHex,
      error_message: null,
      updated_at: trx.fn.now(),
    });
    await trx("tb_parking_sessions").where({ id: session.id, org_id: operation.org_id }).update({
      status: "completed",
      exited_at: paidAt,
      duration_minutes: durationMinutes,
      amount: approvedAmount,
      payment_method: "card",
      exit_method: "manual",
      operator_id: operation.operator_id,
      active_plate_key: null,
    });
    await trx("tb_payments").insert({
      org_id: operation.org_id,
      session_id: session.id,
      amount: approvedAmount,
      payment_method: "card",
      paid_at: paidAt,
      operator_id: operation.operator_id,
    });
    await trx("tb_activity_logs").insert({
      actor_id: operation.operator_id,
      action: "payment_terminal.card_payment_confirmed",
      target_type: "session",
      target_id: session.id,
      details: JSON.stringify({
        orgId: operation.org_id,
        operationNumber: operation.operation_number,
        amount: approvedAmount,
      }),
    });
    const candidate = operation.candidate_id
      ? await trx("tb_exit_candidates")
          .select("webhook_event_id")
          .where({ id: operation.candidate_id, org_id: operation.org_id })
          .first()
      : null;
    const organization = await trx("tb_organizations")
      .select("name", "printer_ip")
      .where({ id: operation.org_id })
      .first();
    return {
      operation,
      session: {
        ...session,
        status: "completed" as const,
        exited_at: paidAt,
        duration_minutes: durationMinutes,
        amount: approvedAmount,
        payment_method: "card" as const,
        exit_method: "manual" as const,
      },
      approvedAmount,
      paidAt,
      webhookEventId: candidate?.webhook_event_id as number | undefined,
      organizationName: String(organization?.name ?? "Stoyanka"),
      printerIp: (organization?.printer_ip as string | null | undefined) ?? null,
    };
  });
  if (!completed) {
    const operation = await db<PaymentTerminalOperationRow>("payment_terminal_operations")
      .where({ id: operationId })
      .first();
    if (operation?.status === "STALE_IGNORED") {
      console.error(
        `STALE CARD PAYMENT: operation=${operation.operation_number}, session allaqachon boshqa usul bilan yopilgan, pul terminal orqali olingan bo'lishi mumkin — QO'LDA TEKSHIRING`
      );
    }
    return;
  }
  const plateNumber = displayPlateNumber(completed.session.plate_number);
  const user = completed.operation.operator_id
    ? await getUserById(completed.operation.operator_id).catch(() => null)
    : null;
  void telegramService
    .sendExitNotification(completed.operation.org_id, {
      plateNumber,
      amount: completed.approvedAmount,
      paymentMethod: "card",
      imageUrl: completed.webhookEventId
        ? `/api/webhook-events/${completed.webhookEventId}/images/overview`
        : null,
      durationText: formatDuration(completed.session.duration_minutes ?? 0),
      confirmedByName: user?.name.trim() || "Noma'lum",
    })
    .catch(() => console.error("TELEGRAM_NOTIFICATION_FAILED"));
  try {
    void ledService
      .showPayment(completed.operation.org_id, plateNumber, completed.approvedAmount)
      .catch((error) => console.error("LED_PAYMENT_FAILED", error));
  } catch (error) {
    console.error("LED_PAYMENT_FAILED", error);
  }
  try {
    ledService.scheduleReturnToClock(completed.operation.org_id);
  } catch (error) {
    console.error("LED_CLOCK_SCHEDULE_FAILED", error);
  }
  if (completed.operation.candidate_id === null) {
    void printReceipt(completed.printerIp, {
      orgName: completed.organizationName,
      plateNumber,
      enteredAt: new Date(completed.session.entered_at),
      exitedAt: new Date(completed.session.exited_at ?? completed.paidAt),
      durationMinutes: completed.session.duration_minutes ?? 0,
      amount: completed.approvedAmount,
      paymentMethod: "card",
      issuedAt: completed.paidAt,
    }).catch((error) => console.error("CARD_RECEIPT_FAILED", error));
  }
  let barrierStatus: "opened" | "disabled" | "not_configured" | "failed" = "failed";
  let barrierDetail: string;
  try {
    const barrier = await openBarrier(completed.operation.org_id, "exit");
    barrierStatus = barrier.status;
    barrierDetail = barrier.detail ?? barrier.status;
  } catch (error) {
    barrierDetail = error instanceof Error ? error.message : String(error);
  }
  const barrierAction =
    barrierStatus === "opened"
      ? "parking.exit_candidate_barrier_opened"
      : barrierStatus === "failed"
        ? "parking.exit_candidate_barrier_open_failed"
        : "parking.exit_candidate_barrier_unavailable";
  await db("tb_activity_logs").insert({
    actor_id: completed.operation.operator_id,
    action: barrierAction,
    target_type: completed.operation.candidate_id === null ? "session" : "exit_candidate",
    target_id: completed.operation.candidate_id ?? completed.session.id,
    details: JSON.stringify({
      orgId: completed.operation.org_id,
      candidateId: completed.operation.candidate_id,
      sessionId: completed.session.id,
      barrierStatus,
      retryAttempt: false,
      detail: barrierDetail,
    }),
  });
  if (barrierStatus === "failed") {
    emitRelayFailed(completed.operation.org_id, {
      direction: "exit",
      plateNumber,
      message: "Shlagbaum avtomatik ochilmadi, qo'lda oching",
    });
  }
  emitExitCompleted(completed.operation.org_id, {
    orgId: completed.operation.org_id,
    sessionId: completed.session.id,
    plateNumber,
    amount: completed.approvedAmount,
    paymentMethod: "card",
    exitMethod: completed.session.exit_method,
    barrierStatus,
    sessionSource: completed.session.session_source,
    durationMinutes: completed.session.duration_minutes,
  });
}

export async function processCardPaymentOperation(
  operationId: number,
  terminal: PaymentTerminal,
  wait: (delayMs: number) => Promise<void> = schedule
): Promise<void> {
  const operation = await db<PaymentTerminalOperationRow>("payment_terminal_operations")
    .where({ id: operationId })
    .first();
  if (!operation || operation.status !== "PENDING") return;
  let payment: PaymentResult;
  try {
    payment = await terminal.startPayment(
      operation.operation_number,
      Number(operation.requested_amount_som)
    );
  } catch (error) {
    payment = {
      status: "ERROR",
      operationNumber: operation.operation_number,
      approvedAmountSom: null,
      rawRequestHex: "",
      rawResponseHex: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  const paymentSaved = await updateOperationWhileStatus(operationId, "PENDING", {
    status: payment.status,
    approved_amount_som: payment.approvedAmountSom,
    raw_vrp_request_hex: payment.rawRequestHex,
    raw_vrp_response_hex: payment.rawResponseHex,
    error_message: payment.errorMessage,
  });
  if (!paymentSaved) return;
  if (payment.status !== "APPROVED" || payment.approvedAmountSom === null) {
    await emitPaymentFailure(
      operation,
      payment.status === "TIMEOUT" ? "timeout" : "declined",
      payment.errorMessage
    );
    return;
  }
  const finalize = async (): Promise<FinResult | null> => {
    const current = await db<PaymentTerminalOperationRow>("payment_terminal_operations")
      .select("status")
      .where({ id: operationId })
      .first();
    if (current?.status !== "APPROVED") return null;
    try {
      return await terminal.finalizePayment(operation.operation_number, payment.approvedAmountSom!);
    } catch (error) {
      return {
        status: "ERROR",
        rawRequestHex: "",
        rawResponseHex: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
  let lastFinResult = await finalize();
  if (!lastFinResult) return;
  for (let attempt = 2; attempt <= FIN_ATTEMPTS && lastFinResult.status !== "FIN_CONFIRMED"; attempt += 1) {
    await wait(FIN_RETRY_DELAY_MS);
    lastFinResult = await finalize();
    if (!lastFinResult) return;
  }
  if (lastFinResult.status === "FIN_CONFIRMED") {
    if (operation.candidate_id !== null) {
      const { completeCardPaymentForCandidate } = await import(
        "@/modules/exitCandidates/exitCandidates.service"
      );
      await completeCardPaymentForCandidate(
        operation.org_id,
        operation.operation_number,
        lastFinResult.rawRequestHex,
        lastFinResult.rawResponseHex
      );
    } else {
      await completeManualCardPayment(
        operationId,
        lastFinResult.rawRequestHex,
        lastFinResult.rawResponseHex
      );
    }
    return;
  }
  const errorMessage = lastFinResult.errorMessage ?? "FIN uch urinishdan keyin tasdiqlanmadi";
  const failureSaved = await updateOperationWhileStatus(operationId, "APPROVED", {
    status: "FIN_FAILED",
    raw_fin_request_hex: lastFinResult.rawRequestHex,
    raw_fin_response_hex: lastFinResult.rawResponseHex,
    error_message: errorMessage,
  });
  if (!failureSaved) return;
  await db("tb_activity_logs").insert({
    actor_id: operation.operator_id,
    action: "payment_terminal.manual_reconciliation_required",
    target_type: "session",
    target_id: operation.session_id,
    details: JSON.stringify({
      orgId: operation.org_id,
      operationNumber: operation.operation_number,
      errorMessage,
    }),
  });
  console.error(
    `MANUAL_RECONCILIATION_REQUIRED org_id=${operation.org_id} operation_number=${operation.operation_number} error=${errorMessage}`
  );
  await emitPaymentFailure(operation, "timeout", errorMessage);
}

export function runCardPaymentInBackground(
  operationId: number,
  operationNumber: string,
  lease: PaymentTerminalLease
): void {
  lease.bindOperation(operationNumber);
  setImmediate(() => {
    void processCardPaymentOperation(operationId, lease.terminal)
      .catch((error) => {
        console.error(`CARD_PAYMENT_BACKGROUND_FAILED operation_id=${operationId}`, error);
      })
      .finally(() => lease.release());
  });
}

export function abortActiveCardPaymentInBackground(input: {
  orgId: number;
  sessionId: number;
  candidateId?: number | null;
}): void {
  setImmediate(() => {
    void (async () => {
      const query = db<PaymentTerminalOperationRow>("payment_terminal_operations")
        .where({ org_id: input.orgId, session_id: input.sessionId })
        .whereIn("status", ["PENDING", "APPROVED"])
        .orderBy("id", "desc");
      if (input.candidateId !== undefined) query.andWhere({ candidate_id: input.candidateId });
      const operation = await query.first();
      if (!operation) return;
      const updated = await db("payment_terminal_operations")
        .where({ id: operation.id })
        .whereIn("status", ["PENDING", "APPROVED"])
        .update({
          status: "ABORTED",
          error_message: "Sessiya boshqa to'lov usuli bilan yopildi",
          updated_at: db.fn.now(),
        });
      if (!updated) return;
      await paymentTerminalManager.abortPendingPayment(input.orgId, operation.operation_number);
      await db("tb_activity_logs").insert({
        actor_id: operation.operator_id,
        action: "payment_terminal.aborted",
        target_type: "session",
        target_id: operation.session_id,
        details: JSON.stringify({
          orgId: operation.org_id,
          operationNumber: operation.operation_number,
          candidateId: operation.candidate_id,
        }),
      });
    })().catch((error) => {
      console.error(`CARD_PAYMENT_ABORT_FAILED session_id=${input.sessionId}`, error);
    });
  });
}
