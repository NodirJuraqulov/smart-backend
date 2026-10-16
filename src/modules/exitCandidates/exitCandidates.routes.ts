import { Router } from "express";
import { isAuth, checkPermission } from "@/middleware/auth.middleware";
import { asyncHandler } from "@/middleware/asyncHandler";
import {
  acceptHandler,
  cancelExitHandler,
  cancelledHistoryHandler,
  confirmHandler,
  detailHandler,
  dismissHandler,
  forceOpenHandler,
  listHandler,
  nextHandler,
  previewSessionHandler,
  reassignHandler,
  retryBarrierHandler,
  searchHandler,
} from "./exitCandidates.controller";

const router = Router();

router.use(isAuth, checkPermission("sessions"));
router.get("/", asyncHandler(listHandler));
router.get("/next", asyncHandler(nextHandler));
router.get("/cancelled", asyncHandler(cancelledHistoryHandler));
router.get("/:id", asyncHandler(detailHandler));
router.post("/:id/search", asyncHandler(searchHandler));
router.post("/:id/preview-session", asyncHandler(previewSessionHandler));
router.post("/:id/confirm", asyncHandler(confirmHandler));
router.post("/:id/force-open", asyncHandler(forceOpenHandler));
router.post("/:id/cancel-exit", asyncHandler(cancelExitHandler));
router.post("/:id/retry-barrier", asyncHandler(retryBarrierHandler));
router.post("/:id/accept", asyncHandler(acceptHandler));
router.post("/:id/reassign", asyncHandler(reassignHandler));
router.post("/:id/dismiss", asyncHandler(dismissHandler));

export default router;
