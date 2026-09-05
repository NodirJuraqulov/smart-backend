export interface PaymentResult {
  status: "APPROVED" | "DECLINED" | "TIMEOUT" | "ERROR";
  operationNumber: string;
  approvedAmountSom: number | null;
  rawRequestHex: string;
  rawResponseHex: string | null;
  errorMessage: string | null;
}

export interface FinResult {
  status: "FIN_CONFIRMED" | "FIN_FAILED" | "TIMEOUT" | "ERROR";
  rawRequestHex: string;
  rawResponseHex: string | null;
  errorMessage: string | null;
}

export interface PaymentTerminal {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  startPayment(operationNumber: string, amountSom: number): Promise<PaymentResult>;
  finalizePayment(operationNumber: string, approvedAmountSom: number): Promise<FinResult>;
  abortPendingPayment(operationNumber: string): Promise<void>;
}
