import express, { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { resolveOrgByWebhookToken } from "@/middleware/webhookAuth";
import { webhookRateLimit } from "@/middleware/webhookRateLimit";
import { cameraHandler, debugHandler, hikvisionHandler } from "./webhook.controller";

const router = Router();

router.use(express.raw({ type: () => true, limit: "20mb" }));

router.post(
  "/debug/:token/:direction(entry|exit)",
  webhookRateLimit,
  resolveOrgByWebhookToken,
  asyncHandler(debugHandler)
);
router.post(
  "/hikvision/:token/:direction(entry|exit)",
  webhookRateLimit,
  resolveOrgByWebhookToken,
  asyncHandler(hikvisionHandler)
);
router.post(
  "/camera/:token/:direction(entry|exit)",
  webhookRateLimit,
  resolveOrgByWebhookToken,
  asyncHandler(cameraHandler)
);

export default router;
