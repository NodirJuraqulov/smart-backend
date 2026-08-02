import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { getDisplayStatus, getEntryDisplayStatus, getExitDisplayStatus } from "./publicDisplay.service";

function parseOrgId(req: Request): number {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId) || orgId < 1) throw new ApiError("orgId noto'g'ri", 400);
  return orgId;
}

export async function statusHandler(req: Request, res: Response) {
  const status = await getDisplayStatus(parseOrgId(req));
  res.json(status);
}

export async function entryStatusHandler(req: Request, res: Response) {
  res.json(await getEntryDisplayStatus(parseOrgId(req)));
}

export async function exitStatusHandler(req: Request, res: Response) {
  res.json(await getExitDisplayStatus(parseOrgId(req)));
}
