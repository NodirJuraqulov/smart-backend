import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, Socket } from "socket.io";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";

let io: SocketIOServer | null = null;

export type ExitBarrierStatus = "opened" | "disabled" | "not_configured" | "failed";

export interface ExitCandidateCreatedPayload {
  candidateId: number;
  orgId: number;
  webhookEventId: number;
  detectedPlate: string | null;
  matchedSessionId: number | null;
  confidence: number | null;
  cameraEventAt: string;
  status: "pending";
  exitImages: {
    overviewUrl: string | null;
    vehicleUrl: string | null;
    plateUrl: string | null;
  };
}

export interface ExitCandidateResolvedPayload {
  candidateId: number;
  orgId: number;
  status: "accepted" | "dismissed";
  resolutionType: "exact" | "reassigned" | "dismissed" | "forced_open";
  sessionId: number | null;
  barrierStatus: ExitBarrierStatus | null;
}

export interface ExitCompletedPayload {
  orgId: number;
  sessionId: number;
  plateNumber: string;
  amount: number;
  paymentMethod: "cash" | "online" | null;
  barrierStatus: ExitBarrierStatus;
}

export interface EntryCandidateCreatedPayload {
  candidateId: number;
  orgId: number;
  detectedPlate: string | null;
  cameraEventAt: string;
  confidence: number | null;
  entryImages: {
    overviewUrl: string | null;
    vehicleUrl: string | null;
    imageAvailable: boolean;
  };
}

export interface EntryCandidateResolvedPayload {
  candidateId: number;
  orgId: number;
  status: "accepted" | "declined" | "expired";
  sessionId: number | null;
  barrierStatus: ExitBarrierStatus | null;
}

export interface EntryCompletedPayload {
  sessionId: number;
  plateNumber: string;
  barrierStatus: ExitBarrierStatus;
}

export interface EntryBarrierFailedPayload {
  sessionId: number;
  plateNumber: string;
  detail: string;
}

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

function resolvePublicOrgId(socket: Socket): number | null {
  const rawOrgId = socket.handshake.auth?.orgId;
  if (rawOrgId === undefined) {
    return null;
  }
  const orgId = Number(rawOrgId);
  return Number.isInteger(orgId) && orgId > 0 ? orgId : null;
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: env.corsOrigin },
  });

  io.use((socket, next) => {
    if (socket.handshake.auth?.orgId !== undefined) {
      next();
      return;
    }

    authenticate(socket)
      .then((user) => {
        socket.data.user = user;
        next();
      })
      .catch((err: Error) => next(err));
  });

  io.on("connection", (socket) => {
    if (socket.handshake.auth?.orgId !== undefined) {
      const publicOrgId = resolvePublicOrgId(socket);
      if (publicOrgId === null) {
        socket.disconnect(true);
        return;
      }
      socket.join(`public:org:${publicOrgId}`);
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

export function emitEntryDetected(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("entry_detected", payload);
  getIO()?.to(`public:org:${orgId}`).emit("entry_detected", payload);
}

export function emitEntryCompleted(orgId: number, payload: EntryCompletedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_completed", payload);
  getIO()?.to(`public:org:${orgId}`).emit("entry_completed", payload);
}

export function emitEntryBarrierFailed(orgId: number, payload: EntryBarrierFailedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_barrier_failed", payload);
}

export function emitEntryCandidateCreated(orgId: number, payload: EntryCandidateCreatedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_candidate_created", payload);
}

export function emitEntryCandidateResolved(orgId: number, payload: EntryCandidateResolvedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_candidate_resolved", payload);
}

export function emitParkingFull(orgId: number, payload: unknown): void {
  getIO()?.to(`public:org:${orgId}`).emit("parking_full", payload);
}

export function emitExitAwaitingPayment(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("exit_awaiting_payment", payload);
  getIO()?.to(`public:org:${orgId}`).emit("exit_awaiting_payment", payload);
}

export function emitExitCompleted(orgId: number, payload: ExitCompletedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_completed", payload);
  getIO()?.to(`public:org:${orgId}`).emit("exit_completed", payload);
}

export function emitExitCandidateCreated(orgId: number, payload: ExitCandidateCreatedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_candidate_created", payload);
}

export function emitExitCandidateResolved(orgId: number, payload: ExitCandidateResolvedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_candidate_resolved", payload);
}

export function emitPlateNotRecognizedForExit(orgId: number, payload: unknown): void {
  getIO()?.to(`public:org:${orgId}`).emit("plate_not_recognized_for_exit", payload);
}

export function emitRelayFailed(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("relay_failed", payload);
}

export function emitWebhookParseFailed(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("webhook_parse_failed", payload);
  getIO()?.to(`public:org:${orgId}`).emit("webhook_parse_failed", payload);
}
