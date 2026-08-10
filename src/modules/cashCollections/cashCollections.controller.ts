import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as cashCollectionsService from "./cashCollections.service";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(req: Request): { page: number; limit: number } {
  const page = Number(req.query.page);
  const limit = Number(req.query.limit);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

export async function pendingSummaryHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const summary = await cashCollectionsService.getPendingSummary(req.user!, orgId);
  res.json(summary);
}

export async function createHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const collection = await cashCollectionsService.createCashCollection(req.user!, orgId, {
    collectedAmount: req.body?.collected_amount,
    note: req.body?.note,
  });
  res.status(201).json({ collection });
}

export async function listHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const result = await cashCollectionsService.listCashCollections(
    req.user!,
    orgId,
    parsePagination(req)
  );
  res.json(result);
}
