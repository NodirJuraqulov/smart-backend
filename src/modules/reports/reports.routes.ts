import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth } from "@/middleware/auth.middleware";
import { dailyHandler, monthlyHandler, yearlyHandler } from "./reports.controller";

const router = Router();

router.use(isAuth, checkPermission("reports"));

router.get("/daily", asyncHandler(dailyHandler));
router.get("/monthly", asyncHandler(monthlyHandler));
router.get("/yearly", asyncHandler(yearlyHandler));

export default router;
