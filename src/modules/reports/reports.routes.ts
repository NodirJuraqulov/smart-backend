import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth } from "@/middleware/auth.middleware";
import { dailyHandler, monthlyHandler, yearlyHandler } from "./reports.controller";
import { checkDailyReportAccess } from "./reports.middleware";

const router = Router();

router.use(isAuth);

router.get("/daily", checkDailyReportAccess, asyncHandler(dailyHandler));
router.get("/monthly", checkPermission("reports"), asyncHandler(monthlyHandler));
router.get("/yearly", checkPermission("reports"), asyncHandler(yearlyHandler));

export default router;
