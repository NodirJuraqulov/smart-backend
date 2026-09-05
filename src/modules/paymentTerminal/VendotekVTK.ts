import net, { Socket } from "net";
import { FinResult, PaymentResult, PaymentTerminal } from "./PaymentTerminal.interface";

const REQUEST_DIRECTION = Buffer.from([0x96, 0xfb]);
const RESPONSE_DIRECTION = Buffer.from([0x97, 0xfb]);
const PAYMENT_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDL_TIMEOUT_MS = 10_000;
const MAX_KEEPALIVE_INTERVAL_MS = 60_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const KNOWN_TAGS = new Set([0x01, 0x03, 0x04, 0x05]);
const MAX_UINT32 = 0xffffffff;

interface ParsedMessage {
  fields: Record<number, string>;
  rawHex: string;
}

interface PendingResponse {
  messageName: string;
  operationNumber?: string;
  resolve: (message: ParsedMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface VendotekVTKOptions {
  orgId: number;
  host: string;
  port: number;
  updateKeepaliveInterval?: (orgId: number, seconds: number) => Promise<void>;
  socketFactory?: (host: string, port: number) => Socket;
  reconnectDelaysMs?: number[];
}

class VtkTimeoutError extends Error {}

export function somToMinor(amountSom: number): number {
  const amountMinor = Math.round(amountSom * 100);
  if (
    !Number.isFinite(amountSom) ||
    amountSom < 0 ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor > MAX_UINT32
  ) {
    throw new Error("To'lov summasi noto'g'ri");
  }
  return amountMinor;
}

export function minorToSom(rawAmount: string): number {
  if (!/^\d+$/.test(rawAmount)) throw new Error("Terminal qaytargan summa noto'g'ri");
  const amountMinor = Number(rawAmount);
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Terminal qaytargan summa noto'g'ri");
  return amountMinor / 100;
}

export function tlv(tag: number, value: Buffer): Buffer {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) throw new Error("TLV tag noto'g'ri");
  if (value.length > 0xff) throw new Error("TLV qiymati 255 baytdan oshmasligi kerak");
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

export function buildMessage(msgName: string, extraFields: Buffer[]): Buffer {
  const body = Buffer.concat([
    REQUEST_DIRECTION,
    tlv(0x01, Buffer.from(msgName, "ascii")),
    ...extraFields,
  ]);
  if (body.length > 0xffff) throw new Error("VTK paket uzunligi chegaradan oshdi");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function fieldsOffset(data: Buffer): number {
  if (
    data.length >= 4 &&
    data.readUInt16BE(0) === data.length - 2 &&
    ((data[2] === REQUEST_DIRECTION[0] && data[3] === REQUEST_DIRECTION[1]) ||
      (data[2] === RESPONSE_DIRECTION[0] && data[3] === RESPONSE_DIRECTION[1]))
  ) {
    return 4;
  }
  if (
    data.length >= 2 &&
    ((data[0] === REQUEST_DIRECTION[0] && data[1] === REQUEST_DIRECTION[1]) ||
      (data[0] === RESPONSE_DIRECTION[0] && data[1] === RESPONSE_DIRECTION[1]))
  ) {
    return 2;
  }
  return 0;
}

export function parseFields(data: Buffer): Record<number, string> {
  const fields: Record<number, string> = {};
  let offset = fieldsOffset(data);
  while (offset < data.length) {
    if (offset + 2 > data.length) throw new Error("VTK TLV sarlavhasi to'liq emas");
    const tag = data[offset];
    const length = data[offset + 1];
    const valueStart = offset + 2;
    const valueEnd = valueStart + length;
    if (valueEnd > data.length) throw new Error("VTK TLV qiymati to'liq emas");
    if (!KNOWN_TAGS.has(tag)) console.warn(`VTK_UNKNOWN_TAG tag=0x${tag.toString(16).padStart(2, "0")}`);
    fields[tag] = data.subarray(valueStart, valueEnd).toString("ascii");
    offset = valueEnd;
  }
  return fields;
}

export class VendotekVTK implements PaymentTerminal {
  private socket: Socket | null = null;
  private connected = false;
  private intentionalDisconnect = false;
  private connecting: Promise<void> | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private pendingResponse: PendingResponse | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private keepaliveRequest: Promise<void> | null = null;
  private keepaliveIntervalSeconds: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private activeOperationNumber: string | null = null;
  private readonly socketFactory: (host: string, port: number) => Socket;
  private readonly reconnectDelaysMs: number[];

  constructor(private readonly options: VendotekVTKOptions) {
    this.socketFactory = options.socketFactory ?? ((host, port) => net.createConnection({ host, port }));
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  }

  isConnected(): boolean {
    return this.connected && this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.intentionalDisconnect = false;
    this.connecting = this.openConnection();
    try {
      await this.connecting;
      this.reconnectAttempt = 0;
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.clearKeepaliveTimer();
    this.rejectPending(new Error("VTK ulanishi yopildi"));
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
      socket.destroy();
    });
  }

  async startPayment(operationNumber: string, amountSom: number): Promise<PaymentResult> {
    const amountMinor = somToMinor(amountSom);
    this.assertOperationNumber(operationNumber);
    const request = buildMessage("VRP", [
      tlv(0x03, Buffer.from(operationNumber, "ascii")),
      tlv(0x04, Buffer.from(String(amountMinor), "ascii")),
    ]);
    const rawRequestHex = request.toString("hex");
    this.activeOperationNumber = operationNumber;
    try {
      await this.connect();
      await this.waitForKeepalive();
      const response = await this.sendRequest(request, "VRP", operationNumber, PAYMENT_TIMEOUT_MS);
      const rawAmount = response.fields[0x04];
      if (rawAmount === undefined || rawAmount === "0") {
        this.activeOperationNumber = null;
        return {
          status: "DECLINED",
          operationNumber,
          approvedAmountSom: null,
          rawRequestHex,
          rawResponseHex: response.rawHex,
          errorMessage: null,
        };
      }
      const approvedAmountSom = minorToSom(rawAmount);
      if (approvedAmountSom <= 0) {
        this.activeOperationNumber = null;
        return {
          status: "DECLINED",
          operationNumber,
          approvedAmountSom: null,
          rawRequestHex,
          rawResponseHex: response.rawHex,
          errorMessage: null,
        };
      }
      return {
        status: "APPROVED",
        operationNumber,
        approvedAmountSom,
        rawRequestHex,
        rawResponseHex: response.rawHex,
        errorMessage: null,
      };
    } catch (error) {
      this.activeOperationNumber = null;
      return {
        status: error instanceof VtkTimeoutError ? "TIMEOUT" : "ERROR",
        operationNumber,
        approvedAmountSom: null,
        rawRequestHex,
        rawResponseHex: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async finalizePayment(operationNumber: string, approvedAmountSom: number): Promise<FinResult> {
    const amountMinor = somToMinor(approvedAmountSom);
    this.assertOperationNumber(operationNumber);
    const request = buildMessage("FIN", [
      tlv(0x03, Buffer.from(operationNumber, "ascii")),
      tlv(0x04, Buffer.from(String(amountMinor), "ascii")),
    ]);
    const rawRequestHex = request.toString("hex");
    try {
      await this.connect();
      await this.waitForKeepalive();
      const response = await this.sendRequest(request, "FIN", operationNumber, PAYMENT_TIMEOUT_MS);
      const responseAmount = response.fields[0x04];
      if (responseAmount !== String(amountMinor)) {
        return {
          status: "FIN_FAILED",
          rawRequestHex,
          rawResponseHex: response.rawHex,
          errorMessage: "FIN javob summasi so'rov summasiga mos emas",
        };
      }
      this.activeOperationNumber = null;
      return {
        status: "FIN_CONFIRMED",
        rawRequestHex,
        rawResponseHex: response.rawHex,
        errorMessage: null,
      };
    } catch (error) {
      return {
        status: error instanceof VtkTimeoutError ? "TIMEOUT" : "ERROR",
        rawRequestHex,
        rawResponseHex: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async abortPendingPayment(operationNumber: string): Promise<void> {
    if (this.activeOperationNumber !== operationNumber) return;
    this.activeOperationNumber = null;
    await this.disconnect();
    this.intentionalDisconnect = false;
    void this.connect().catch((error) => {
      console.error(`VTK_ABORT_RECONNECT_FAILED org_id=${this.options.orgId}`, error);
    });
  }

  private assertOperationNumber(operationNumber: string): void {
    if (!/^\d{1,8}$/.test(operationNumber)) {
      throw new Error("Operation number 1-8 ta ASCII raqamdan iborat bo'lishi kerak");
    }
  }

  private async openConnection(): Promise<void> {
    this.clearReconnectTimer();
    const socket = this.socketFactory(this.options.host, this.options.port);
    this.socket = socket;
    this.receiveBuffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => {
      console.error(`VTK_SOCKET_ERROR org_id=${this.options.orgId}`, error);
    });
    socket.on("close", () => this.handleClose(socket));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("VTK terminaliga ulanish vaqti tugadi"));
        socket.destroy();
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log(`VTK_CONNECTED org_id=${this.options.orgId}`);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    try {
      const idl = buildMessage("IDL", []);
      const response = await this.sendRequest(idl, "IDL", undefined, IDL_TIMEOUT_MS);
      await this.applyKeepalive(response.fields[0x05]);
    } catch (error) {
      this.connected = false;
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      throw error;
    }
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 2) {
      const frameLength = this.receiveBuffer.readUInt16BE(0);
      const totalLength = frameLength + 2;
      if (this.receiveBuffer.length < totalLength) return;
      const packet = this.receiveBuffer.subarray(0, totalLength);
      this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
      this.handlePacket(packet);
    }
  }

  private handlePacket(packet: Buffer): void {
    const rawHex = packet.toString("hex");
    if (packet[2] !== RESPONSE_DIRECTION[0] || packet[3] !== RESPONSE_DIRECTION[1]) {
      console.error(
        `VTK_PARSE_ERROR org_id=${this.options.orgId} hex=${rawHex}`,
        new Error("VTK javob yo'nalishi noto'g'ri")
      );
      return;
    }
    let fields: Record<number, string>;
    try {
      fields = parseFields(packet);
    } catch (error) {
      console.error(`VTK_PARSE_ERROR org_id=${this.options.orgId} hex=${rawHex}`, error);
      return;
    }
    const operationNumber = fields[0x03] ?? "-";
    console.log(`VTK_RX org_id=${this.options.orgId} operation_number=${operationNumber} hex=${rawHex}`);
    const pending = this.pendingResponse;
    if (!pending) return;
    if (fields[0x01] !== pending.messageName) return;
    if (pending.operationNumber !== undefined && fields[0x03] !== pending.operationNumber) return;
    this.pendingResponse = null;
    clearTimeout(pending.timeout);
    pending.resolve({ fields, rawHex });
  }

  private sendRequest(
    request: Buffer,
    messageName: string,
    operationNumber: string | undefined,
    timeoutMs: number
  ): Promise<ParsedMessage> {
    if (!this.isConnected() || !this.socket) return Promise.reject(new Error("VTK terminal ulanmagan"));
    if (this.pendingResponse) return Promise.reject(new Error("VTK terminal band, biroz kutib qayta urining"));
    const rawHex = request.toString("hex");
    console.log(
      `VTK_TX org_id=${this.options.orgId} operation_number=${operationNumber ?? "-"} hex=${rawHex}`
    );
    return new Promise<ParsedMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingResponse?.resolve !== resolve) return;
        this.pendingResponse = null;
        reject(new VtkTimeoutError(`${messageName} javobi ${timeoutMs / 1000} sekundda kelmadi`));
      }, timeoutMs);
      this.pendingResponse = { messageName, operationNumber, resolve, reject, timeout };
      this.socket!.write(request, (error) => {
        if (!error) return;
        if (this.pendingResponse?.resolve === resolve) this.pendingResponse = null;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private async applyKeepalive(rawSeconds: string | undefined): Promise<void> {
    if (!rawSeconds || !/^\d+$/.test(rawSeconds)) throw new Error("IDL keepalive interval noto'g'ri");
    const seconds = Number(rawSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("IDL keepalive interval noto'g'ri");
    if (this.keepaliveIntervalSeconds !== seconds) {
      await this.options.updateKeepaliveInterval?.(this.options.orgId, seconds);
      this.keepaliveIntervalSeconds = seconds;
    }
    this.clearKeepaliveTimer();
    const intervalMs = Math.min(
      Math.max(Math.floor((seconds * 1000) / 2), 1),
      MAX_KEEPALIVE_INTERVAL_MS
    );
    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected() || this.pendingResponse || this.keepaliveRequest) return;
      const request = buildMessage("IDL", []);
      this.keepaliveRequest = this.sendRequest(request, "IDL", undefined, IDL_TIMEOUT_MS)
        .then((response) => this.applyKeepalive(response.fields[0x05]))
        .catch((error) => {
          console.error(`VTK_KEEPALIVE_FAILED org_id=${this.options.orgId}`, error);
          this.socket?.destroy();
        })
        .finally(() => {
          this.keepaliveRequest = null;
        });
    }, intervalMs);
    this.keepaliveTimer.unref();
  }

  private async waitForKeepalive(): Promise<void> {
    if (this.keepaliveRequest) await this.keepaliveRequest;
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);
    this.clearKeepaliveTimer();
    this.rejectPending(new Error("VTK terminal ulanishi uzildi"));
    console.warn(`VTK_DISCONNECTED org_id=${this.options.orgId}`);
    this.scheduleReconnect();
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingResponse;
    if (!pending) return;
    this.pendingResponse = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnectTimer || this.isConnected()) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delayMs = this.reconnectDelaysMs[index] ?? 30_000;
    this.reconnectAttempt += 1;
    console.warn(
      `VTK_RECONNECT_SCHEDULED org_id=${this.options.orgId} attempt=${this.reconnectAttempt} delay_ms=${delayMs}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`VTK_RECONNECT_ATTEMPT org_id=${this.options.orgId} attempt=${this.reconnectAttempt}`);
      void this.connect().catch((error) => {
        console.error(`VTK_RECONNECT_FAILED org_id=${this.options.orgId}`, error);
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private clearKeepaliveTimer(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
