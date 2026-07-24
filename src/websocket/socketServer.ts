import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, Socket } from "socket.io";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { onAgentDisconnected, onFrameChunk, onLiveViewError, onLiveViewStarted } from "./liveViewRelay";

let io: SocketIOServer | null = null;

const connectedAgents = new Map<number, Set<string>>();

async function authenticate(socket: Socket): Promise<AuthTokenPayload> {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    throw new Error("Token topilmadi");
  }

  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, env.jwt.secret) as AuthTokenPayload;
  } catch {
    throw new Error("Token yaroqsiz yoki muddati tugagan");
  }

  const user = await db("tb_users").where({ id: payload.id }).first();
  if (!user || !user.is_active) {
    throw new Error("Hisob bloklangan yoki mavjud emas");
  }

  if (user.org_id) {
    const organization = await db("tb_organizations").where({ id: user.org_id }).first();
    if (!organization || !organization.is_active) {
      throw new Error("Stoyanka bloklangan");
    }
  }

  return payload;
}

async function authenticateAgent(socket: Socket): Promise<number> {
  const agentKey = socket.handshake.auth?.agentKey as string | undefined;
  if (!agentKey) {
    throw new Error("Agent kaliti topilmadi");
  }

  const settings = await db("tb_settings").where({ agent_api_key: agentKey }).first();
  if (!settings) {
    throw new Error("Noto'g'ri agent kaliti");
  }

  const organization = await db("tb_organizations").where({ id: settings.org_id }).first();
  if (!organization || !organization.is_active) {
    throw new Error("Stoyanka bloklangan");
  }

  return settings.org_id;
}

function addConnectedAgent(orgId: number, socketId: string): void {
  if (!connectedAgents.has(orgId)) {
    connectedAgents.set(orgId, new Set());
  }
  connectedAgents.get(orgId)!.add(socketId);
}

function removeConnectedAgent(orgId: number, socketId: string): void {
  connectedAgents.get(orgId)?.delete(socketId);
}

export function isAgentConnected(orgId: number): boolean {
  return (connectedAgents.get(orgId)?.size ?? 0) > 0;
}

export function emitToAgent(orgId: number, event: string, payload: unknown): void {
  getIO()?.to(`agent_${orgId}`).emit(event, payload);
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: env.corsOrigin },
  });

  io.use((socket, next) => {
    const isAgentHandshake = Boolean(socket.handshake.auth?.agentKey);

    const authPromise = isAgentHandshake
      ? authenticateAgent(socket).then((orgId) => {
          socket.data.isAgent = true;
          socket.data.orgId = orgId;
        })
      : authenticate(socket).then((user) => {
          socket.data.isAgent = false;
          socket.data.user = user;
        });

    authPromise.then(() => next()).catch((err: Error) => next(err));
  });

  io.on("connection", (socket) => {
    if (socket.data.isAgent) {
      const orgId = socket.data.orgId as number;
      socket.join(`agent_${orgId}`);
      addConnectedAgent(orgId, socket.id);

      socket.on("live_view:started", (payload: { type: "entry" | "exit"; content_type: string }) => {
        onLiveViewStarted(orgId, payload.type, payload.content_type);
      });

      socket.on("live_view:chunk", (payload: { type: "entry" | "exit"; chunk: Buffer }) => {
        onFrameChunk(orgId, payload.type, payload.chunk);
      });

      socket.on("live_view:error", (payload: { type: "entry" | "exit"; message: string }) => {
        onLiveViewError(orgId, payload.type, payload.message);
      });

      socket.on("disconnect", () => {
        removeConnectedAgent(orgId, socket.id);
        if (!isAgentConnected(orgId)) {
          onAgentDisconnected(orgId);
        }
      });

      return;
    }

    const user = socket.data.user as AuthTokenPayload;

    if (user.role === "super_admin") {
      socket.join("admins");
    } else if (user.org_id) {
      socket.join(`org_${user.org_id}`);
    }
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function emitParkingEntry(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("parking:entry", payload);
}

export function emitParkingExit(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("parking:exit", payload);
}

export function emitDetectionFailed(
  orgId: number,
  payload: { type: "entry" | "exit"; image_url: string | null }
): void {
  getIO()?.to(`org_${orgId}`).emit("parking:detection_failed", payload);
}
