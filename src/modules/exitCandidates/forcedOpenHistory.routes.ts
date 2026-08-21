import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOwnerOrKassir } from "@/middleware/auth.middleware";
import { forcedOpenHistoryHandler } from "./forcedOpenHistory.controller";

const router = Router();

router.use(isAuth, isSuperAdminOrOwnerOrKassir);
router.get("/:id/forced-open-history", asyncHandler(forcedOpenHistoryHandler));

export default router;
