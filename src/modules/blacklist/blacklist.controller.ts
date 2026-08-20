import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as blacklistService from "./blacklist.service";

function parseBlacklistId(req: Request, res: Response): number | null {
  const value = Number(req.params.blacklistId);
  if (!Number.isInteger(value) || value <= 0) {
    res.status(400).json({ message: "blacklistId noto'g'ri" });
    return null;
  }
  return value;
}

function parsePagination(req: Request, res: Response): { page: number; limit: number } | null {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "page va limit noto'g'ri" });
    return null;
  }
  return { page, limit };
}

export async function listHandler(req: Request, res: Response): Promise<void> {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const vehicles = await blacklistService.listBlacklistedVehicles(req.user!, orgId);
  res.json({ vehicles });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const { plate_number, reason } = req.body ?? {};
  if (typeof plate_number !== "string" || !plate_number.trim()) {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    res.status(400).json({ message: "reason matn bo'lishi kerak" });
    return;
  }
  const vehicle = await blacklistService.createBlacklistedVehicle(req.user!, orgId, {
    plateNumber: plate_number,
    reason,
  });
  res.status(201).json({ vehicle });
}

export async function deleteHandler(req: Request, res: Response): Promise<void> {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const blacklistId = parseBlacklistId(req, res);
  if (blacklistId === null) return;
  await blacklistService.deleteBlacklistedVehicle(req.user!, orgId, blacklistId);
  res.status(204).send();
}

export async function attemptsHandler(req: Request, res: Response): Promise<void> {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const pagination = parsePagination(req, res);
  if (!pagination) return;
  res.json(await blacklistService.listBlacklistAttempts(req.user!, orgId, pagination));
}
