import type { PaymentMethod } from "@/modules/payment/paymentMethod";

export type PublicDisplayState =
  | "idle"
  | "awaiting_operator"
  | "awaiting_payment"
  | "completed"
  | "barrier_failed"
  | "declined";

export type PublicBarrierStatus = "opened" | "failed" | "disabled" | "not_configured";

export function publicDisplayStateForBarrier(
  status: PublicBarrierStatus | null
): "completed" | "barrier_failed" {
  return status === "opened" ? "completed" : "barrier_failed";
}

export interface PublicEntryDisplayStatus {
  state: PublicDisplayState;
  plate: string | null;
  barrier_status: PublicBarrierStatus | null;
  updated_at: string;
}

export interface PublicExitDisplayStatus extends PublicEntryDisplayStatus {
  session_source: "regular" | "subscription" | "vip" | null;
  amount: number | null;
  payment_method: PaymentMethod | null;
  duration_minutes: number | null;
}
