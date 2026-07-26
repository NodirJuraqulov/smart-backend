export type PaymentTransactionState = "created" | "performed" | "cancelled";

export interface CreatePaymentTransactionResult {
  transactionId: string;
  payUrl?: string;
}

export interface CheckPaymentTransactionResult {
  state: PaymentTransactionState;
}

export interface PaymentProvider {
  createTransaction(sessionId: number, amount: number): Promise<CreatePaymentTransactionResult>;
  checkTransaction(transactionId: string): Promise<CheckPaymentTransactionResult>;
  cancelTransaction(transactionId: string): Promise<boolean>;
}
