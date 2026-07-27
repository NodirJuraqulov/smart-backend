import { Request, Response } from "express";
import rateLimit from "express-rate-limit";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 60;
const PAYMENT_MAX_REQUESTS = 100;

function tooManyRequestsHandler(req: Request, res: Response) {
  res.status(429).json({ message: "Juda ko'p so'rov, birozdan keyin urinib ko'ring" });
}

export function createWebhookRateLimit(limit: number) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => `webhook_token:${req.params.token}`,
    handler: tooManyRequestsHandler,
  });
}

export function createPaymentWebhookRateLimit(limit: number) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooManyRequestsHandler,
  });
}

export const webhookRateLimit = createWebhookRateLimit(MAX_REQUESTS);
export const paymentWebhookRateLimit = createPaymentWebhookRateLimit(PAYMENT_MAX_REQUESTS);
