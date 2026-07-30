import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth } from "@/middleware/auth.middleware";
import { webhookEventImageHandler } from "./webhookEvents.controller";

const router = Router();

router.use(isAuth);
router.get("/:id/images/:kind", asyncHandler(webhookEventImageHandler));

export default router;
