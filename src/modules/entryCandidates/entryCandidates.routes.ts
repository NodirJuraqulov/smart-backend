import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth } from "@/middleware/auth.middleware";
import { acceptHandler, declineHandler, nextHandler } from "./entryCandidates.controller";

const router = Router();

router.use(isAuth, checkPermission("sessions"));
router.get("/next", asyncHandler(nextHandler));
router.post("/:id/accept", asyncHandler(acceptHandler));
router.post("/:id/decline", asyncHandler(declineHandler));

export default router;
