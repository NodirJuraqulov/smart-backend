import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth } from "@/middleware/auth.middleware";
import { manualEntryHandler, retryEntryBarrierHandler } from "./entryCandidates.controller";

const router = Router();

router.use(isAuth, checkPermission("sessions"));
router.post("/manual-entry", asyncHandler(manualEntryHandler));
router.post("/:id/retry-entry-barrier", asyncHandler(retryEntryBarrierHandler));

export default router;
