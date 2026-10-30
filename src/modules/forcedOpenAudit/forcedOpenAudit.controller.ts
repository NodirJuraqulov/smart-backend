import { Request, Response } from "express";
import * as service from "./forcedOpenAudit.service";

function parseRequiredId(value: unknown, field: string, res: Response): number | null {
  const id = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: `${field} majburiy va musbat butun son bo'lishi kerak` });
    return null;
  }
  return id;
}

function parseOptionalId(value: unknown, field: string, res: Response): number | undefined | null {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: `${field} musbat butun son bo'lishi kerak` });
    return null;
  }
  return id;
}

function parseDate(value: unknown, res: Response): string | null {
  if (typeof value !== "string" || value === "") {
    res.status(400).json({ message: "date majburiy va YYYY-MM-DD formatida bo'lishi kerak" });
    return null;
  }
  return value;
}

export async function listAuditHandler(req: Request, res: Response): Promise<void> {
  const operatorId = parseRequiredId(req.query.operator_id, "operator_id", res);
  if (operatorId === null) return;
  const date = parseDate(req.query.date, res);
  if (date === null) return;
  res.json(await service.listForcedOpenAudit(req.user!, operatorId, date));
}

export async function searchHandler(req: Request, res: Response): Promise<void> {
  const candidateId = parseRequiredId(req.body?.candidate_id, "candidate_id", res);
  if (candidateId === null) return;
  if (typeof req.body?.plate !== "string" || req.body.plate.trim() === "") {
    res.status(400).json({ message: "plate majburiy" });
    return;
  }
  res.json(await service.searchForcedOpenSessions(req.user!, candidateId, req.body.plate));
}

export async function createReviewHandler(req: Request, res: Response): Promise<void> {
  const candidateId = parseRequiredId(req.body?.candidate_id, "candidate_id", res);
  if (candidateId === null) return;
  const sessionId = parseOptionalId(req.body?.session_id, "session_id", res);
  if (sessionId === null) return;
  const review = await service.createForcedOpenReview(req.user!, candidateId, sessionId);
  res.status(201).json(review);
}

export async function listReviewsHandler(req: Request, res: Response): Promise<void> {
  const operatorId = parseRequiredId(req.query.operator_id, "operator_id", res);
  if (operatorId === null) return;
  const date = parseDate(req.query.date, res);
  if (date === null) return;
  res.json(await service.listForcedOpenReviews(req.user!, operatorId, date));
}
