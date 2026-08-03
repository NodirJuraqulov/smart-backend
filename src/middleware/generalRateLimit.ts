import { Request, Response } from "express";
import rateLimit from "express-rate-limit";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 300;

function tooManyRequestsHandler(req: Request, res: Response) {
  res.status(429).json({ message: "So'rovlar limiti oshdi. Bir daqiqadan keyin qayta urining." });
}

export function createGeneralApiRateLimit(limit = MAX_REQUESTS) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooManyRequestsHandler,
  });
}

export const generalApiRateLimit = createGeneralApiRateLimit();
