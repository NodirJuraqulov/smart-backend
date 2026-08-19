import net from "net";
import { env } from "@/config/env";

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

export function sendPackets(packets: Buffer[]): Promise<void> {
  if (packets.length === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: env.led.host, port: env.led.port });
    let packetIndex = 0;
    let waitingForAck = false;
    let settled = false;

    const fail = (error: LedClientError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.end();
      resolve();
    };

    const sendCurrentPacket = (): void => {
      waitingForAck = true;
      socket.write(packets[packetIndex], (error) => {
        if (error) {
          fail(new LedClientError("LED_SEND_FAILED", error.message));
        }
      });
    };

    socket.setNoDelay(true);
    socket.setTimeout(env.led.timeoutMs);
    socket.once("connect", sendCurrentPacket);
    socket.on("data", (data) => {
      if (!waitingForAck || data.length === 0 || settled) return;
      waitingForAck = false;
      packetIndex += 1;
      if (packetIndex === packets.length) {
        finish();
        return;
      }
      sendCurrentPacket();
    });
    socket.once("timeout", () => {
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
