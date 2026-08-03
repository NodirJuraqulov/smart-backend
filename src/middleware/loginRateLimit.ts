import { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttemptsHandler(req: Request, res: Response) {
  res.status(429).json({
    message: "Login urinishlari limiti oshdi. Bir daqiqadan keyin qayta urining.",
  });
}

export const loginIpRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyAttemptsHandler,
});

export const loginUsernameRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const login = typeof req.body?.login === "string" ? req.body.login.trim().toLowerCase() : null;
    return login ? `login:${login}` : ipKeyGenerator(req.ip ?? "unknown");
  },
  handler: tooManyAttemptsHandler,
});
