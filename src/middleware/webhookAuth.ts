import { NextFunction, Request, Response } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { db } from "@/config/db";

async function resolveOrgByWebhookTokenHandler(req: Request, res: Response, next: NextFunction) {
  const token = req.params.token;

  const organization = await db("tb_organizations").where({ webhook_token: token }).first();
  if (!organization || !organization.is_active) {
    res.status(404).json({ message: "Topilmadi" });
    return;
  }

  req.webhookOrgId = organization.id;
  next();
}

export const resolveOrgByWebhookToken = asyncHandler(resolveOrgByWebhookTokenHandler);
