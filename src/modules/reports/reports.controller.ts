import { Request, Response } from "express";
import { parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import * as reportsService from "./reports.service";

export async function dailyHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const date = req.query.date as string | undefined;

  const report = await reportsService.getDailyReport(req.user!, orgId, date);
  res.json(report);
}

export async function monthlyHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const yearRaw = req.query.year as string | undefined;
  const monthRaw = req.query.month as string | undefined;

  if (yearRaw !== undefined && !Number.isInteger(Number(yearRaw))) {
    res.status(400).json({ message: "year noto'g'ri" });
    return;
  }
  if (monthRaw !== undefined && !Number.isInteger(Number(monthRaw))) {
    res.status(400).json({ message: "month noto'g'ri" });
    return;
  }

  const report = await reportsService.getMonthlyReport(
    req.user!,
    orgId,
    yearRaw !== undefined ? Number(yearRaw) : undefined,
    monthRaw !== undefined ? Number(monthRaw) : undefined
  );
  res.json(report);
}

export async function yearlyHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const yearRaw = req.query.year as string | undefined;

  if (yearRaw !== undefined && !Number.isInteger(Number(yearRaw))) {
    res.status(400).json({ message: "year noto'g'ri" });
    return;
  }

  const report = await reportsService.getYearlyReport(
    req.user!,
    orgId,
    yearRaw !== undefined ? Number(yearRaw) : undefined
  );
  res.json(report);
}
