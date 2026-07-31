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

export async function acceptHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = requestScope(req, res);
  if (orgId === null) return;
  res.json({ candidate: await service.acceptExitCandidate(req.user!, orgId, id) });
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
  res.json({ candidate: await service.reassignExitCandidate(req.user!, orgId, id, sessionId) });
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
