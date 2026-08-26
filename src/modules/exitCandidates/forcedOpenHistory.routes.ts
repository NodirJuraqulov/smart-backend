import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOwnerOrKassir } from "@/middleware/auth.middleware";
import { emergencyExitHistoryHandler } from "./emergencyExitHistory.controller";
import { forcedOpenHistoryHandler } from "./forcedOpenHistory.controller";

const router = Router();

router.use(isAuth, isSuperAdminOrOwnerOrKassir);
router.get("/:id/forced-open-history", asyncHandler(forcedOpenHistoryHandler));
router.get("/:id/emergency-exit-history", asyncHandler(emergencyExitHistoryHandler));

export default router;
