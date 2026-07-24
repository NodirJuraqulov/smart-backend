import { Request, Response } from "express";
import * as activityLogsService from "./activityLogs.service";

export async function listHandler(req: Request, res: Response) {
  const page = req.query.page !== undefined ? Number(req.query.page) : 1;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;

  if (!Number.isInteger(page) || page < 1) {
    res.status(400).json({ message: "page noto'g'ri" });
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "limit noto'g'ri (1-100 oralig'ida bo'lishi kerak)" });
    return;
  }

  const date = req.query.date as string | undefined;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ message: "date formati noto'g'ri (YYYY-MM-DD)" });
    return;
  }

  const result = await activityLogsService.listActivityLogs({
    action: req.query.action as string | undefined,
    target_type: req.query.target_type as string | undefined,
    date,
    page,
    limit,
  });

  res.json(result);
}
