import { NextFunction, Request, Response } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { db } from "@/config/db";

function resolveOrgByToken(tokenColumn: "medplus_discount_webhook_token" | "medplus_inpatient_webhook_token") {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = req.params.token;

    const organization = await db("tb_organizations").where({ [tokenColumn]: token }).first();
    if (!organization || !organization.is_active) {
      res.status(404).json({ message: "Topilmadi" });
      return;
    }

    req.medplusOrgId = organization.id;
    next();
  });
}

export const resolveOrgByMedplusDiscountToken = resolveOrgByToken("medplus_discount_webhook_token");
export const resolveOrgByMedplusInpatientToken = resolveOrgByToken("medplus_inpatient_webhook_token");
