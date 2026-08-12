import { createServer } from "http";
import type { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  emitEntryCompleted,
  emitExitCandidateCreated,
  emitExitCompleted,
  getIO,
  initSocketServer,
} from "@/websocket/socketServer";

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

  it("public status event faqat ruxsat etilgan maydonlarni yuboradi", async () => {
    const orgId = 5151;
    const client = connectPublicClient(orgId);

    const received = new Promise((resolve) => {
      client.on("public:exit-status-changed", resolve);
    });

    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
    });

    emitExitCompleted(orgId, {
      orgId,
      sessionId: 7788,
      plateNumber: "01F111AA",
      amount: 5000,
      paymentMethod: "online",
      barrierStatus: "opened",
      sessionSource: "regular",
      durationMinutes: 61,
    });

    await expect(received).resolves.toEqual({
      state: "completed",
      plate: "01F111AA",
      session_source: "regular",
      amount: 5000,
      payment_method: "online",
      duration_minutes: 61,
      barrier_status: "opened",
      updated_at: expect.any(String),
    });
  });

  it("public status event boshqa organization roomiga o'tmaydi", async () => {
    const ownClient = connectPublicClient(6161);
    const otherClient = connectPublicClient(6262);
    await Promise.all(
      [ownClient, otherClient].map(
        (client) =>
          new Promise<void>((resolve, reject) => {
            client.on("connect", resolve);
            client.on("connect_error", reject);
          })
      )
    );
    const ownReceived = new Promise((resolve) => ownClient.once("public:exit-status-changed", resolve));
    let otherReceived = false;
    otherClient.once("public:exit-status-changed", () => {
      otherReceived = true;
    });

    emitExitCandidateCreated(6161, {
      candidateId: 1,
      orgId: 6161,
      webhookEventId: 2,
      detectedPlate: "01F222AA",
      suggestedPlate: null,
      matchedSessionId: null,
      confidence: 90,
      cameraEventAt: new Date().toISOString(),
      status: "pending",
      exitImages: { overviewUrl: null, vehicleUrl: null, plateUrl: null },
    });

    await expect(ownReceived).resolves.toMatchObject({ state: "awaiting_operator", plate: "01F222AA" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherReceived).toBe(false);
  });

  it.each(["disabled", "not_configured"] as const)(
    "entry public WebSocket barrier_status=%s bo'lsa barrier_failed yuboradi",
    async (barrierStatus) => {
      const orgId = barrierStatus === "disabled" ? 7171 : 7272;
      const client = connectPublicClient(orgId);
      const received = new Promise((resolve) => client.once("public:entry-status-changed", resolve));
      await new Promise<void>((resolve, reject) => {
        client.on("connect", resolve);
        client.on("connect_error", reject);
      });

      emitEntryCompleted(orgId, {
        sessionId: 1,
        plateNumber: "01W111AA",
        barrierStatus,
      });

      await expect(received).resolves.toMatchObject({
        state: "barrier_failed",
        barrier_status: barrierStatus,
      });
    }
  );

  it.each(["disabled", "not_configured"] as const)(
    "exit public WebSocket barrier_status=%s bo'lsa barrier_failed yuboradi",
    async (barrierStatus) => {
      const orgId = barrierStatus === "disabled" ? 7373 : 7474;
      const client = connectPublicClient(orgId);
      const received = new Promise((resolve) => client.once("public:exit-status-changed", resolve));
      await new Promise<void>((resolve, reject) => {
        client.on("connect", resolve);
        client.on("connect_error", reject);
      });

      emitExitCompleted(orgId, {
        orgId,
        sessionId: 2,
        plateNumber: "01W222AA",
        amount: 5000,
        paymentMethod: "cash",
        barrierStatus,
      });

      await expect(received).resolves.toMatchObject({
        state: "barrier_failed",
        barrier_status: barrierStatus,
      });
    }
  );

  it("noto'g'ri orgId bilan ulanish rad etiladi", async () => {
    const client = connectPublicClient("not-a-number");

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    await disconnected;
    expect(client.connected).toBe(false);
  });
});
