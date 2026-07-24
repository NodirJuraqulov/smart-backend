import { Request, Response } from "express";
import rateLimit from "express-rate-limit";

const WINDOW_MS = 10 * 1000;

function tooManyRequestsHandler(req: Request, res: Response) {
  res.status(429).json({ message: "Juda ko'p so'rov, birozdan keyin urinib ko'ring" });
}

export const agentParkingRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `agent_org:${req.orgId}`,
  handler: tooManyRequestsHandler,
});

export const operatorParkingRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const orgId = req.user?.org_id ?? req.body?.org_id;
    return orgId ? `operator_org:${orgId}` : `operator_user:${req.user?.id ?? "unknown"}`;
  },
  handler: tooManyRequestsHandler,
});
