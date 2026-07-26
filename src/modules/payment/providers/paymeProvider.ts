import { env } from "@/config/env";
import { PaymentProvider } from "../paymentProvider.interface";

function warnIfDisabled(): void {
  if (!env.payments.paymeEnabled) {
    console.warn("Payme integratsiyasi hali yoqilmagan (PAYME_ENABLED=false)");
  }
}

export const paymeProvider: PaymentProvider = {
  async createTransaction(_sessionId: number, _amount: number) {
    warnIfDisabled();
    throw new Error("Not implemented");
  },

  async checkTransaction(_transactionId: string) {
    warnIfDisabled();
    throw new Error("Not implemented");
  },

  async cancelTransaction(_transactionId: string) {
    warnIfDisabled();
    throw new Error("Not implemented");
  },
};
