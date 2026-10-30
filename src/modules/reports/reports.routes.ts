import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import {
  checkPermission,
  isAuth,
  isSuperAdminOrOperatorOrOwner,
} from "@/middleware/auth.middleware";
import {
  dailyHandler,
  exitControlHandler,
  monthlyHandler,
  shiftHandler,
  shiftOperatorHandler,
  yearlyHandler,
} from "./reports.controller";
import { checkDailyReportAccess } from "./reports.middleware";

const router = Router();

router.use(isAuth);

router.get("/daily", checkDailyReportAccess, asyncHandler(dailyHandler));
router.get("/shift-operator", checkDailyReportAccess, asyncHandler(shiftOperatorHandler));
router.get("/shift", checkDailyReportAccess, asyncHandler(shiftHandler));
router.get("/monthly", checkPermission("reports"), asyncHandler(monthlyHandler));
router.get("/yearly", checkPermission("reports"), asyncHandler(yearlyHandler));
router.get(
  "/exit-control",
  isSuperAdminOrOperatorOrOwner,
  checkPermission("reports"),
  asyncHandler(exitControlHandler)
);

export default router;
