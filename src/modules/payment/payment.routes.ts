import express, { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { paymentWebhookRateLimit } from "@/middleware/webhookRateLimit";
import { clickWebhookHandler, paymeWebhookHandler } from "./payment.controller";

const router = Router();

router.use(express.raw({ type: () => true, limit: "5mb" }));

router.post("/payme/webhook", paymentWebhookRateLimit, asyncHandler(paymeWebhookHandler));
router.post("/click/webhook", paymentWebhookRateLimit, asyncHandler(clickWebhookHandler));

export default router;
