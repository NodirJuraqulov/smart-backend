import { EventEmitter } from "events";
import type { Socket } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMessage,
  minorToSom,
  parseFields,
  somToMinor,
  tlv,
  VendotekVTK,
} from "@/modules/paymentTerminal/VendotekVTK";

const IDL_RESPONSE = Buffer.from(
  "001697fb010349444c030831343336323631340503363030",
  "hex"
);

function responseMessage(name: string, operation?: string, amount?: string): Buffer {
  const fields = [];
  if (operation !== undefined) fields.push(tlv(0x03, Buffer.from(operation, "ascii")));
  if (amount !== undefined) fields.push(tlv(0x04, Buffer.from(amount, "ascii")));
  const packet = buildMessage(name, fields);
  packet[2] = 0x97;
  return packet;
}

class SocketMock extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  onWrite: ((packet: Buffer) => void) | null = null;

  write(packet: Buffer, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(packet));
    callback?.();
    this.onWrite?.(packet);
    return true;
  }

  end(): this {
    this.destroy();
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function connectedSocket(handler: (socket: SocketMock, fields: Record<number, string>) => void): SocketMock {
  const socket = new SocketMock();
  socket.onWrite = (packet) => handler(socket, parseFields(packet));
  queueMicrotask(() => socket.emit("connect"));
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Vendotek VTK protokoli", () => {
  it("real IDL, VRP va FIN paketlarini aynan quradi va parse qiladi", () => {
    expect(buildMessage("IDL", []).toString("hex")).toBe("000796fb010349444c");
    expect(
      buildMessage("VRP", [
        tlv(0x03, Buffer.from("14479821", "ascii")),
        tlv(0x04, Buffer.from("300000", "ascii")),
      ]).toString("hex")
    ).toBe("001996fb0103565250030831343437393832310406333030303030");
    expect(
      buildMessage("FIN", [
        tlv(0x03, Buffer.from("14479821", "ascii")),
        tlv(0x04, Buffer.from("300000", "ascii")),
      ]).toString("hex")
    ).toBe("001996fb010346494e030831343437393832310406333030303030");
    expect(parseFields(IDL_RESPONSE)).toEqual({
      1: "IDL",
      3: "14362614",
      5: "600",
    });
  });

  it("summani som va minor unit orasida ikki yo'nalishda aylantiradi", () => {
    expect(somToMinor(10)).toBe(1000);
    expect(somToMinor(3000)).toBe(300000);
    expect(minorToSom("1000")).toBe(10);
    expect(minorToSom("300000")).toBe(3000);
  });

  it("musbat amountni APPROVED, yo'q yoki nol amountni DECLINED deb oladi", async () => {
    const sockets: SocketMock[] = [];
    const terminal = new VendotekVTK({
      orgId: 1,
      host: "127.0.0.1",
      port: 62801,
      socketFactory: () => {
        const socket = connectedSocket((current, fields) => {
          queueMicrotask(() => {
            if (fields[1] === "IDL") current.emit("data", IDL_RESPONSE);
            if (fields[1] === "VRP") {
              current.emit("data", responseMessage("VRP", fields[3], fields[3] === "1" ? "300000" : "0"));
            }
          });
        });
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });
    await expect(terminal.startPayment("1", 3000)).resolves.toMatchObject({
      status: "APPROVED",
      approvedAmountSom: 3000,
    });
    await expect(terminal.startPayment("2", 3000)).resolves.toMatchObject({
      status: "DECLINED",
      approvedAmountSom: null,
    });
    expect(sockets).toHaveLength(1);
    await terminal.disconnect();
  });

  it("VRP 60 sekundda javobsiz qolsa TIMEOUT qaytaradi va qayta yubormaydi", async () => {
    vi.useFakeTimers();
    const socket = connectedSocket((current, fields) => {
      if (fields[1] === "IDL") queueMicrotask(() => current.emit("data", IDL_RESPONSE));
    });
    const terminal = new VendotekVTK({
      orgId: 2,
      host: "127.0.0.1",
      port: 62801,
      socketFactory: () => socket as unknown as Socket,
    });
    const result = terminal.startPayment("3", 3000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({ status: "TIMEOUT" });
    const vrpCount = socket.writes.filter((packet) => parseFields(packet)[1] === "VRP").length;
    expect(vrpCount).toBe(1);
    await terminal.disconnect();
  });

  it("IDL keepalive 600 bo'lsa 60 sekunddan keyin qayta IDL yuboradi", async () => {
    vi.useFakeTimers();
    const updateKeepalive = vi.fn().mockResolvedValue(undefined);
    const socket = connectedSocket((current, fields) => {
      if (fields[1] === "IDL") queueMicrotask(() => current.emit("data", IDL_RESPONSE));
    });
    const terminal = new VendotekVTK({
      orgId: 3,
      host: "127.0.0.1",
      port: 62801,
      updateKeepaliveInterval: updateKeepalive,
      socketFactory: () => socket as unknown as Socket,
    });
    await terminal.connect();
    expect(socket.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(socket.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.writes).toHaveLength(2);
    expect(updateKeepalive).toHaveBeenCalledWith(3, 600);
    await terminal.disconnect();
  });

  it("uzilishdan keyin backoff orqali qayta ulanadi", async () => {
    vi.useFakeTimers();
    const sockets: SocketMock[] = [];
    const terminal = new VendotekVTK({
      orgId: 4,
      host: "127.0.0.1",
      port: 62801,
      reconnectDelaysMs: [1_000],
      socketFactory: () => {
        const socket = connectedSocket((current, fields) => {
          if (fields[1] === "IDL") queueMicrotask(() => current.emit("data", IDL_RESPONSE));
        });
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });
    await terminal.connect();
    sockets[0].destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await terminal.disconnect();
  });

  it("faol VRP abort qilinganda socketni yopib yangi IDL bilan ulanadi", async () => {
    const sockets: SocketMock[] = [];
    const terminal = new VendotekVTK({
      orgId: 5,
      host: "127.0.0.1",
      port: 62801,
      socketFactory: () => {
        const socket = connectedSocket((current, fields) => {
          if (fields[1] === "IDL") queueMicrotask(() => current.emit("data", IDL_RESPONSE));
        });
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });
    const payment = terminal.startPayment("7", 3000);
    await vi.waitFor(() => {
      expect(sockets[0]?.writes.some((packet) => parseFields(packet)[1] === "VRP")).toBe(true);
    });
    await terminal.abortPendingPayment("7");
    await expect(payment).resolves.toMatchObject({ status: "ERROR" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0].destroyed).toBe(true);
    expect(parseFields(sockets[1].writes[0])[1]).toBe("IDL");
    await terminal.disconnect();
  });

  it("noma'lum TLV tagni log qiladi va parsingni davom ettiradi", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fields = parseFields(
      Buffer.concat([
        tlv(0x01, Buffer.from("VRP", "ascii")),
        tlv(0x44, Buffer.from("unknown", "ascii")),
        tlv(0x04, Buffer.from("300000", "ascii")),
      ])
    );
    expect(fields[1]).toBe("VRP");
    expect(fields[4]).toBe("300000");
    expect(fields[0x44]).toBe("unknown");
    expect(warning).toHaveBeenCalledOnce();
  });
});
