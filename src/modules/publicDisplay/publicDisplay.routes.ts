import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { entryStatusHandler, exitStatusHandler, statusHandler } from "./publicDisplay.controller";

const router = Router();

router.get("/:orgId/status", asyncHandler(statusHandler));
router.get("/:orgId/entry-status", asyncHandler(entryStatusHandler));
router.get("/:orgId/exit-status", asyncHandler(exitStatusHandler));

export default router;
