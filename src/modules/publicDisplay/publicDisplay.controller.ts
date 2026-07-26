import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { getDisplayStatus } from "./publicDisplay.service";

export async function statusHandler(req: Request, res: Response) {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId)) {
    throw new ApiError("orgId noto'g'ri", 400);
  }

  const status = await getDisplayStatus(orgId);
  res.json(status);
}
