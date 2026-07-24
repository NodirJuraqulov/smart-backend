import type { Response } from "express";
import { emitToAgent, isAgentConnected } from "./socketServer";

type CameraType = "entry" | "exit";

interface StreamState {
  orgId: number;
  type: CameraType;
  contentType: string | null;
  viewers: Set<Response>;
  ackTimeout: NodeJS.Timeout | null;
}

const streams = new Map<string, StreamState>();

const ACK_TIMEOUT_MS = 10_000;

function streamKey(orgId: number, type: CameraType): string {
  return `${orgId}:${type}`;
}

function clearAckTimeout(state: StreamState): void {
  if (state.ackTimeout) {
    clearTimeout(state.ackTimeout);
    state.ackTimeout = null;
  }
}

function endAllViewers(state: StreamState, errorMessage: string): void {
  for (const res of state.viewers) {
    try {
      if (!res.headersSent) {
        res.status(502).json({ message: errorMessage });
      } else {
        res.end();
      }
    } catch {

    }
  }
  state.viewers.clear();
}

export function addViewer(orgId: number, type: CameraType, res: Response): void {
  const key = streamKey(orgId, type);
  let state = streams.get(key);

  if (!state) {
    if (!isAgentConnected(orgId)) {
      res.status(503).json({ message: "s-agent ulanmagan — kamera oqimi mavjud emas" });
      return;
    }

    state = { orgId, type, contentType: null, viewers: new Set(), ackTimeout: null };
    streams.set(key, state);

    const pendingState = state;
    state.ackTimeout = setTimeout(() => {
      endAllViewers(pendingState, "Kamera oqimini boshlashda vaqt tugadi (s-agent javob bermadi)");
      streams.delete(key);
    }, ACK_TIMEOUT_MS);

    emitToAgent(orgId, "live_view:start", { type });
  }

  state.viewers.add(res);

  if (state.contentType) {
    res.writeHead(200, { "Content-Type": state.contentType });
  }

  res.on("close", () => removeViewer(orgId, type, res));
}

export function removeViewer(orgId: number, type: CameraType, res: Response): void {
  const key = streamKey(orgId, type);
  const state = streams.get(key);
  if (!state) return;

  state.viewers.delete(res);

  if (state.viewers.size === 0) {
    clearAckTimeout(state);
    streams.delete(key);
    emitToAgent(orgId, "live_view:stop", { type });
  }
}

export function onLiveViewStarted(orgId: number, type: CameraType, contentType: string): void {
  const key = streamKey(orgId, type);
  const state = streams.get(key);
  if (!state) return;

  clearAckTimeout(state);
  state.contentType = contentType;

  for (const res of state.viewers) {
    try {
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": contentType });
      }
    } catch {

    }
  }
}

export function onFrameChunk(orgId: number, type: CameraType, chunk: Buffer): void {
  const key = streamKey(orgId, type);
  const state = streams.get(key);
  if (!state) return;

  for (const res of state.viewers) {
    try {
      if (res.headersSent) {
        res.write(chunk);
      }
    } catch {

    }
  }
}

export function onLiveViewError(orgId: number, type: CameraType, message: string): void {
  const key = streamKey(orgId, type);
  const state = streams.get(key);
  if (!state) return;

  clearAckTimeout(state);
  endAllViewers(state, message);
  streams.delete(key);
}

export function onAgentDisconnected(orgId: number): void {
  for (const type of ["entry", "exit"] as CameraType[]) {
    const key = streamKey(orgId, type);
    const state = streams.get(key);
    if (!state) continue;

    clearAckTimeout(state);
    endAllViewers(state, "s-agent uzildi — kamera oqimi to'xtadi");
    streams.delete(key);
  }
}

export function shutdownAllStreams(): void {
  for (const state of streams.values()) {
    clearAckTimeout(state);
    emitToAgent(state.orgId, "live_view:stop", { type: state.type });
    endAllViewers(state, "Server qayta ishga tushirilmoqda");
  }
  streams.clear();
}
