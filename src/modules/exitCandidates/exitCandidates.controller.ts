import { Request, Response } from "express";
import { parseId, parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import * as service from "./exitCandidates.service";

function pagination(req: Request, res: Response): { page: number; limit: number } | null {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "page va limit noto'g'ri" });
    return null;
  }
  return { page, limit };
}

function requestScope(req: Request, res: Response): number | undefined | null {
  return parseOptionalOrgIdFromQuery(req, res);
}

export async function listHandler(req: Request, res: Response) {
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  const input = pagination(req, res);
  if (!input) return;
  res.json(await service.listExitCandidates(req.user!, orgId, input));
}

export async function detailHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  res.json(await service.getExitCandidate(req.user!, orgId, id));
}

export async function nextHandler(req: Request, res: Response) {
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  const result = await service.getNextExitCandidate(req.user!, orgId);
  if ("candidate" in result && result.candidate === null) {
    res.status(204).send();
    return;
  }
  res.json(result);
}

export async function searchHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  if (req.body?.plate !== undefined && typeof req.body.plate !== "string") {
    res.status(400).json({ message: "plate matn bo'lishi kerak" });
    return;
  }
  res.json(await service.searchExitCandidateSessions(req.user!, orgId, id, req.body?.plate));
}

function parseSessionId(req: Request, res: Response): number | undefined | null {
  if (req.body?.session_id === undefined) return undefined;
  const sessionId = Number(req.body.session_id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    res.status(400).json({ message: "session_id noto'g'ri" });
    return null;
  }
  return sessionId;
}

function parsePaymentMethod(req: Request, res: Response): "cash" | "online" | undefined | null {
  if (req.body?.payment_method === undefined) return undefined;
  if (req.body.payment_method !== "cash" && req.body.payment_method !== "online") {
    res.status(400).json({ message: "payment_method 'cash' yoki 'online' bo'lishi kerak" });
    return null;
  }
  return req.body.payment_method;
}

export async function confirmHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  const sessionId = parseSessionId(req, res);
  if (sessionId === null) return;
  const paymentMethod = parsePaymentMethod(req, res);
  if (paymentMethod === null) return;
  res.json(await service.confirmExitCandidate(req.user!, orgId, id, { sessionId, paymentMethod }));
}

export async function forceOpenHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  if (typeof req.body?.reason !== "string") {
    res.status(400).json({ message: "reason majburiy" });
    return;
  }
  if (req.body.note !== undefined && typeof req.body.note !== "string") {
    res.status(400).json({ message: "note matn bo'lishi kerak" });
    return;
  }
  if (req.body.entered_plate !== undefined && typeof req.body.entered_plate !== "string") {
    res.status(400).json({ message: "entered_plate matn bo'lishi kerak" });
    return;
  }
  res.json(
    await service.forceOpenExitCandidate(req.user!, orgId, id, {
      reason: req.body.reason as service.ForceOpenReason,
      note: req.body.note,
      enteredPlate: req.body.entered_plate,
    })
  );
}

export async function retryBarrierHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  res.json(await service.retryExitCandidateBarrier(req.user!, orgId, id));
}

export async function acceptHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  const paymentMethod = parsePaymentMethod(req, res);
  if (paymentMethod === null) return;
  res.json(await service.acceptExitCandidate(req.user!, orgId, id, paymentMethod));
}

export async function reassignHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  const sessionId = Number(req.body?.session_id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    res.status(400).json({ message: "session_id noto'g'ri" });
    return;
  }
  const paymentMethod = parsePaymentMethod(req, res);
  if (paymentMethod === null) return;
  res.json(await service.reassignExitCandidate(req.user!, orgId, id, sessionId, paymentMethod));
}

export async function dismissHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  if (req.body?.note !== undefined && typeof req.body.note !== "string") {
    res.status(400).json({ message: "note matn bo'lishi kerak" });
    return;
  }
  res.json({ candidate: await service.dismissExitCandidate(req.user!, orgId, id, req.body?.note) });
}
