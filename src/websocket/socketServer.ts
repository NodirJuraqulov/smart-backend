import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, Socket } from "socket.io";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  PublicEntryDisplayStatus,
  PublicExitDisplayStatus,
  publicDisplayStateForBarrier,
} from "@/modules/publicDisplay/publicDisplay.types";

let io: SocketIOServer | null = null;

export type ExitBarrierStatus = "opened" | "disabled" | "not_configured" | "failed";

export interface ExitCandidateCreatedPayload {
  candidateId: number;
  orgId: number;
  webhookEventId: number;
  detectedPlate: string | null;
  suggestedPlate: string | null;
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
  status: "accepted" | "dismissed" | "expired";
  resolutionType: "exact" | "reassigned" | "dismissed" | "forced_open" | null;
  sessionId: number | null;
  barrierStatus: ExitBarrierStatus | null;
  plateNumber?: string | null;
  sessionSource?: "regular" | "subscription" | "vip" | null;
  amount?: number | null;
  paymentMethod?: "cash" | "online" | null;
  durationMinutes?: number | null;
}

export interface ExitCompletedPayload {
  orgId: number;
  sessionId: number;
  plateNumber: string;
  amount: number;
  paymentMethod: "cash" | "online" | null;
  barrierStatus: ExitBarrierStatus;
  sessionSource?: "regular" | "subscription" | "vip" | null;
  durationMinutes?: number | null;
}

export interface EntryCandidateCreatedPayload {
  candidateId: number;
  orgId: number;
  detectedPlate: string | null;
  suggestedPlate: string | null;
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
  plateNumber?: string | null;
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

export function emitPublicEntryStatusChanged(orgId: number, payload: PublicEntryDisplayStatus): void {
  getIO()?.to(`public:org:${orgId}`).emit("public:entry-status-changed", payload);
}

export function emitPublicExitStatusChanged(orgId: number, payload: PublicExitDisplayStatus): void {
  getIO()?.to(`public:org:${orgId}`).emit("public:exit-status-changed", payload);
}

export function emitEntryDetected(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("entry_detected", payload);
}

export function emitEntryCompleted(orgId: number, payload: EntryCompletedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_completed", payload);
  emitPublicEntryStatusChanged(orgId, {
    state: publicDisplayStateForBarrier(payload.barrierStatus),
    plate: payload.plateNumber,
    barrier_status: payload.barrierStatus,
    updated_at: new Date().toISOString(),
  });
}

export function emitEntryBarrierFailed(orgId: number, payload: EntryBarrierFailedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_barrier_failed", payload);
  emitPublicEntryStatusChanged(orgId, {
    state: "barrier_failed",
    plate: payload.plateNumber,
    barrier_status: "failed",
    updated_at: new Date().toISOString(),
  });
}

export function emitEntryCandidateCreated(orgId: number, payload: EntryCandidateCreatedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_candidate_created", payload);
  emitPublicEntryStatusChanged(orgId, {
    state: "awaiting_operator",
    plate: payload.detectedPlate,
    barrier_status: null,
    updated_at: new Date().toISOString(),
  });
}

export function emitEntryCandidateResolved(orgId: number, payload: EntryCandidateResolvedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("entry_candidate_resolved", payload);
  if (payload.status === "expired") {
    emitPublicEntryStatusChanged(orgId, {
      state: "idle",
      plate: null,
      barrier_status: null,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  emitPublicEntryStatusChanged(orgId, {
    state:
      payload.status === "declined"
        ? "declined"
        : publicDisplayStateForBarrier(payload.barrierStatus),
    plate: payload.plateNumber ?? null,
    barrier_status: payload.barrierStatus,
    updated_at: new Date().toISOString(),
  });
}

export function emitParkingFull(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("parking_full", payload);
}

export function emitExitAwaitingPayment(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("exit_awaiting_payment", payload);
}

export function emitExitCompleted(orgId: number, payload: ExitCompletedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_completed", payload);
  emitPublicExitStatusChanged(orgId, {
    state: publicDisplayStateForBarrier(payload.barrierStatus),
    plate: payload.plateNumber,
    session_source: payload.sessionSource ?? null,
    amount: payload.amount,
    payment_method: payload.paymentMethod,
    duration_minutes: payload.durationMinutes ?? null,
    barrier_status: payload.barrierStatus,
    updated_at: new Date().toISOString(),
  });
}

export function emitExitCandidateCreated(orgId: number, payload: ExitCandidateCreatedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_candidate_created", payload);
  emitPublicExitStatusChanged(orgId, {
    state: "awaiting_operator",
    plate: payload.detectedPlate,
    session_source: null,
    amount: null,
    payment_method: null,
    duration_minutes: null,
    barrier_status: null,
    updated_at: new Date().toISOString(),
  });
}

export function emitExitCandidateResolved(orgId: number, payload: ExitCandidateResolvedPayload): void {
  getIO()?.to(`org_${orgId}`).emit("exit_candidate_resolved", payload);
  if (payload.status === "expired") {
    emitPublicExitStatusChanged(orgId, {
      state: "idle",
      plate: null,
      session_source: null,
      amount: null,
      payment_method: null,
      duration_minutes: null,
      barrier_status: null,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  const barrierState = publicDisplayStateForBarrier(payload.barrierStatus);
  emitPublicExitStatusChanged(orgId, {
    state:
      payload.status === "dismissed" && payload.barrierStatus === null
        ? "declined"
        : barrierState === "barrier_failed"
        ? barrierState
        : payload.status === "dismissed"
          ? "declined"
          : barrierState,
    plate: payload.plateNumber ?? null,
    session_source: payload.sessionSource ?? null,
    amount: payload.amount ?? null,
    payment_method: payload.paymentMethod ?? null,
    duration_minutes: payload.durationMinutes ?? null,
    barrier_status: payload.barrierStatus,
    updated_at: new Date().toISOString(),
  });
}

export function emitPlateNotRecognizedForExit(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("plate_not_recognized_for_exit", payload);
}

export function emitRelayFailed(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("relay_failed", payload);
}

export function emitWebhookParseFailed(orgId: number, payload: unknown): void {
  getIO()?.to(`org_${orgId}`).emit("webhook_parse_failed", payload);
}
