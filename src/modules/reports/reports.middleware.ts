import { NextFunction, Request, Response } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { hasPermission } from "@/modules/operatorPermissions/operatorPermissions.service";

const PERMISSION_DENIED = { message: "Ruxsat yo'q — bu bo'limga kirish cheklangan" };

async function checkDailyReportAccessHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.user?.role !== "operator") {
    next();
    return;
  }

  const canViewReports = await hasPermission(req.user.org_id, "reports");
  if (canViewReports) {
    next();
    return;
  }

  const canViewDashboard = await hasPermission(req.user.org_id, "dashboard");
  if (canViewDashboard && Object.keys(req.query).length === 0) {
    next();
    return;
  }

  res.status(403).json(PERMISSION_DENIED);
}

export const checkDailyReportAccess = asyncHandler(checkDailyReportAccessHandler);
