import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import { listForcedOpenHistory } from "./forcedOpenHistory.service";

export async function forcedOpenHistoryHandler(req: Request, res: Response): Promise<void> {
  const orgId = parseId(req, res);
  if (orgId === null) return;

  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);

  if (!Number.isInteger(page) || page < 1) {
    res.status(400).json({ message: "page noto'g'ri" });
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "limit noto'g'ri (1-100 oralig'ida bo'lishi kerak)" });
    return;
  }

  res.json(await listForcedOpenHistory(req.user!, orgId, { page, limit }));
}
