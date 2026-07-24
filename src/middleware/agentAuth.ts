import { NextFunction, Request, Response } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { db } from "@/config/db";

async function agentAuthHandler(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-Agent-Key");
  if (!key) {
    res.status(401).json({ message: "Noto'g'ri agent kaliti" });
    return;
  }

  const settings = await db("tb_settings").where({ agent_api_key: key }).first();
  if (!settings) {
    res.status(401).json({ message: "Noto'g'ri agent kaliti" });
    return;
  }

  const organization = await db("tb_organizations").where({ id: settings.org_id }).first();
  if (!organization || !organization.is_active) {
    res.status(401).json({ message: "Stoyanka bloklangan" });
    return;
  }

  req.orgId = settings.org_id;
  next();
}

export const agentAuth = asyncHandler(agentAuthHandler);
