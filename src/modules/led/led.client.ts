import net from "net";
import { env } from "@/config/env";
import {
  createLedDiagnosticTrace,
  LedDiagnosticTrace,
  logLedDiagnostic,
} from "./led.diagnostics";

export type LedClientErrorCode = "LED_SEND_FAILED" | "LED_ACK_TIMEOUT";

export class LedClientError extends Error {
  constructor(
    public readonly code: LedClientErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LedClientError";
  }
}

export function sendPackets(
  packets: Buffer[],
  trace: LedDiagnosticTrace = createLedDiagnosticTrace("direct-tcp")
): Promise<void> {
  if (packets.length === 0) {
    logLedDiagnostic("LED_DIAG_TCP_SEND_FINISHED", trace, { packetCount: 0 });
    return Promise.resolve();
  }
  const connectStartedAtMs = logLedDiagnostic("LED_DIAG_TCP_CONNECT_START", trace, {
    host: env.led.host,
    port: env.led.port,
    timeoutMs: env.led.timeoutMs,
    packetCount: packets.length,
  });
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: env.led.host, port: env.led.port });
    let packetIndex = 0;
    let waitingForAck = false;
    let settled = false;
    let packetWriteStartedAtMs = 0;

    const fail = (error: LedClientError): void => {
      if (settled) return;
      settled = true;
      logLedDiagnostic("LED_DIAG_TCP_SEND_FAILED", trace, {
        packetIndex,
        waitingForAck,
        code: error.code,
        error: error.message,
      });
      socket.destroy();
      reject(error);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.end();
      logLedDiagnostic("LED_DIAG_TCP_SEND_FINISHED", trace, {
        packetCount: packets.length,
        tcpElapsedMs: Date.now() - connectStartedAtMs,
      });
      resolve();
    };

    const sendCurrentPacket = (): void => {
      waitingForAck = true;
      const currentPacketIndex = packetIndex;
      const currentPacketWriteStartedAtMs = logLedDiagnostic("LED_DIAG_PACKET_SEND_START", trace, {
        packetIndex: currentPacketIndex,
        packetNumber: currentPacketIndex + 1,
        packetCount: packets.length,
        packetBytes: packets[currentPacketIndex].length,
      });
      packetWriteStartedAtMs = currentPacketWriteStartedAtMs;
      socket.write(packets[packetIndex], (error) => {
        logLedDiagnostic("LED_DIAG_PACKET_WRITE_COMPLETE", trace, {
          packetIndex: currentPacketIndex,
          packetNumber: currentPacketIndex + 1,
          packetCount: packets.length,
          writeElapsedMs: Date.now() - currentPacketWriteStartedAtMs,
          error: error?.message ?? null,
        });
        if (error) {
          fail(new LedClientError("LED_SEND_FAILED", error.message));
        }
      });
    };

    socket.setNoDelay(true);
    socket.setTimeout(env.led.timeoutMs);
    socket.once("connect", () => {
      logLedDiagnostic("LED_DIAG_TCP_CONNECTED", trace, {
        host: env.led.host,
        port: env.led.port,
        connectElapsedMs: Date.now() - connectStartedAtMs,
      });
      sendCurrentPacket();
    });
    socket.on("data", (data) => {
      if (!waitingForAck || data.length === 0 || settled) return;
      logLedDiagnostic("LED_DIAG_ACK_RECEIVED", trace, {
        packetIndex,
        packetNumber: packetIndex + 1,
        packetCount: packets.length,
        ackBytes: data.length,
        ackElapsedMs: Date.now() - packetWriteStartedAtMs,
      });
      waitingForAck = false;
      packetIndex += 1;
      if (packetIndex === packets.length) {
        finish();
        return;
      }
      sendCurrentPacket();
    });
    socket.once("timeout", () => {
      logLedDiagnostic("LED_DIAG_TCP_TIMEOUT", trace, {
        packetIndex,
        waitingForAck,
        timeoutMs: env.led.timeoutMs,
      });
      const code = waitingForAck ? "LED_ACK_TIMEOUT" : "LED_SEND_FAILED";
      fail(new LedClientError(code, waitingForAck ? "LED ACK timeout" : "LED connection timeout"));
    });
    socket.once("error", (error) => {
      fail(new LedClientError("LED_SEND_FAILED", error.message));
    });
    socket.once("end", () => {
      if (!settled) {
        fail(new LedClientError("LED_ACK_TIMEOUT", "LED connection closed before ACK"));
      }
    });
    socket.once("close", () => {
      if (!settled) {
        fail(new LedClientError("LED_ACK_TIMEOUT", "LED connection closed before ACK"));
      }
    });
  });
}
