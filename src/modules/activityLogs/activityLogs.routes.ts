import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import { listHandler } from "./activityLogs.controller";

const router = Router();

router.use(isAuth, isSuperAdmin, checkPermission("activity_log"));

router.get("/", asyncHandler(listHandler));

export default router;
