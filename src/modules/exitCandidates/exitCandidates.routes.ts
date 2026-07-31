import { Router } from "express";
import { isAuth, checkPermission } from "@/middleware/auth.middleware";
import { asyncHandler } from "@/middleware/asyncHandler";
import {
  acceptHandler,
  detailHandler,
  dismissHandler,
  listHandler,
  reassignHandler,
} from "./exitCandidates.controller";

const router = Router();

router.use(isAuth, checkPermission("sessions"));
router.get("/", asyncHandler(listHandler));
router.get("/:id", asyncHandler(detailHandler));
router.post("/:id/accept", asyncHandler(acceptHandler));
router.post("/:id/reassign", asyncHandler(reassignHandler));
router.post("/:id/dismiss", asyncHandler(dismissHandler));

export default router;
