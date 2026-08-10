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

function parseRequiredOperatorId(value: unknown, res: Response): number | null {
  const operatorId = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isInteger(operatorId) || operatorId <= 0) {
    res.status(400).json({ message: "operator_id majburiy va musbat butun son bo'lishi kerak" });
    return null;
  }
  return operatorId;
}

export async function operatorsListHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const operators = await cashCollectionsService.listOrganizationOperators(req.user!, orgId);
  res.json({ operators });
}

export async function pendingSummaryHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const operatorId = parseRequiredOperatorId(req.query.operator_id, res);
  if (operatorId === null) return;

  const summary = await cashCollectionsService.getPendingSummary(req.user!, orgId, operatorId);
  res.json(summary);
}

export async function createHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const operatorId = parseRequiredOperatorId(req.body?.operator_id, res);
  if (operatorId === null) return;

  const collection = await cashCollectionsService.createCashCollection(req.user!, orgId, {
    operatorId,
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
