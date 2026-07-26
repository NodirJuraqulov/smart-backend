import { createServer } from "http";
import type { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getIO, initSocketServer } from "@/websocket/socketServer";

let serverUrl: string;
let httpServer: ReturnType<typeof createServer>;
let clientSockets: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  initSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });

  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://localhost:${port}`;
});

afterEach(() => {
  for (const socket of clientSockets) {
    socket.disconnect();
  }
  clientSockets = [];
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function connectPublicClient(orgId: unknown): ClientSocket {
  const socket = ioClient(serverUrl, { auth: { orgId }, forceNew: true });
  clientSockets.push(socket);
  return socket;
}

describe("Public display Socket.IO ulanishi", () => {
  it("auth tokenisiz, orgId bilan public:org:{orgId} xonasiga qo'shiladi", async () => {
    const orgId = 4242;
    const client = connectPublicClient(orgId);

    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const room = getIO()?.sockets.adapter.rooms.get(`public:org:${orgId}`);
    expect(room?.size).toBe(1);
  });

  it("public xonaga yuborilgan event mijozga yetib boradi", async () => {
    const orgId = 5151;
    const client = connectPublicClient(orgId);

    const received = new Promise((resolve) => {
      client.on("entry_detected", resolve);
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
    });

    getIO()?.to(`public:org:${orgId}`).emit("entry_detected", { plateNumber: "01F111AA" });

    await expect(received).resolves.toEqual({ plateNumber: "01F111AA" });
  });

  it("noto'g'ri orgId bilan ulanish rad etiladi", async () => {
    const client = connectPublicClient("not-a-number");

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    await disconnected;
    expect(client.connected).toBe(false);
  });
});
