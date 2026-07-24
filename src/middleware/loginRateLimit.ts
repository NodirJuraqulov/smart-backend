import { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

function tooManyAttemptsHandler(req: Request, res: Response) {
  res.status(429).json({
    message: "Juda ko'p muvaffaqiyatsiz urinish. 15 daqiqadan keyin qayta urining.",
  });
}

export const loginIpRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_FAILED_ATTEMPTS,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyAttemptsHandler,
});

export const loginUsernameRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_FAILED_ATTEMPTS,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const login = typeof req.body?.login === "string" ? req.body.login.trim().toLowerCase() : null;
    return login ? `login:${login}` : ipKeyGenerator(req.ip ?? "unknown");
  },
  handler: tooManyAttemptsHandler,
});
