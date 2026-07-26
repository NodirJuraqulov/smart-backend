import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { statusHandler } from "./publicDisplay.controller";

const router = Router();

router.get("/:orgId/status", asyncHandler(statusHandler));

export default router;
