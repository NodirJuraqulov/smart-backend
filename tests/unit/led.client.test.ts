import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock("net", () => ({
  default: {
    createConnection: mocks.createConnection,
  },
}));

vi.mock("@/config/env", () => ({
  env: {
    led: {
      host: "192.168.1.157",
      port: 10000,
      timeoutMs: 3000,
    },
  },
}));

import { LedClientError, sendPackets } from "@/modules/led/led.client";

class SocketMock extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly setNoDelay = vi.fn();
  readonly setTimeout = vi.fn();
  readonly end = vi.fn();
  readonly destroy = vi.fn();

  write(packet: Buffer, callback: (error?: Error | null) => void): boolean {
    this.writes.push(packet);
    callback();
    return true;
  }
}

let socket: SocketMock;

beforeEach(() => {
  socket = new SocketMock();
  mocks.createConnection.mockReset().mockReturnValue(socket);
});

describe("LED TCP client", () => {
  it("har packetdan keyin ACK kutib keyingi packetni yuboradi", async () => {
    const result = sendPackets([Buffer.from([1]), Buffer.from([2])]);
    socket.emit("connect");
    expect(socket.writes).toEqual([Buffer.from([1])]);
    socket.emit("data", Buffer.from([0xaa]));
    expect(socket.writes).toEqual([Buffer.from([1]), Buffer.from([2])]);
    socket.emit("data", Buffer.from([0xaa]));
    await expect(result).resolves.toBeUndefined();
    expect(socket.end).toHaveBeenCalledTimes(1);
  });

  it("ACK timeoutni LED_ACK_TIMEOUT bilan reject qiladi", async () => {
    const result = sendPackets([Buffer.from([1])]);
    socket.emit("connect");
    socket.emit("timeout");
    await expect(result).rejects.toMatchObject<Partial<LedClientError>>({ code: "LED_ACK_TIMEOUT" });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("connection refusedni LED_SEND_FAILED bilan reject qiladi", async () => {
    const result = sendPackets([Buffer.from([1])]);
    socket.emit("error", new Error("connection refused"));
    await expect(result).rejects.toMatchObject<Partial<LedClientError>>({ code: "LED_SEND_FAILED" });
  });
});
