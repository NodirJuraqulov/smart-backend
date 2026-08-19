import express, { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { resolveOrgByWebhookToken } from "@/middleware/webhookAuth";
import { webhookRateLimit } from "@/middleware/webhookRateLimit";
import { cameraHandler, debugHandler, hikvisionHandler } from "./webhook.controller";
import { ensureExitWebhookDiagnosticTrace } from "@/modules/led/led.diagnostics";

const router = Router();

router.use((req, _res, next) => {
  const requestPath = req.path;
  if (
    req.method === "POST" &&
    requestPath.endsWith("/exit") &&
    (requestPath.startsWith("/camera/") || requestPath.startsWith("/hikvision/"))
  ) {
    ensureExitWebhookDiagnosticTrace(req, {
      method: req.method,
      endpoint: requestPath.startsWith("/camera/") ? "camera" : "hikvision",
      contentLength: req.headers["content-length"] ?? null,
    });
  }
  next();
});

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
