import { env } from "@/config/env";
import { PaymentProvider } from "../paymentProvider.interface";

function warnIfDisabled(): void {
  if (!env.payments.clickEnabled) {
    console.warn("Click integratsiyasi hali yoqilmagan (CLICK_ENABLED=false)");
  }
}

export const clickProvider: PaymentProvider = {
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
