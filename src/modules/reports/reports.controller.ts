import { Request, Response } from "express";
import { parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import * as reportsService from "./reports.service";

export async function dailyHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const date = req.query.date as string | undefined;
  const fromDate = req.query.from_date as string | undefined;
  const toDate = req.query.to_date as string | undefined;

  const report =
    fromDate !== undefined || toDate !== undefined
      ? await reportsService.getDailyRangeReport(req.user!, orgId, fromDate, toDate)
      : await reportsService.getDailyReport(req.user!, orgId, date);
  res.json(report);
}

export async function monthlyHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const yearRaw = req.query.year as string | undefined;
  const monthRaw = req.query.month as string | undefined;
  const fromMonth = req.query.from_month as string | undefined;
  const toMonth = req.query.to_month as string | undefined;

  if (yearRaw !== undefined && !Number.isInteger(Number(yearRaw))) {
    res.status(400).json({ message: "year noto'g'ri" });
    return;
  }
  if (monthRaw !== undefined && !Number.isInteger(Number(monthRaw))) {
    res.status(400).json({ message: "month noto'g'ri" });
    return;
  }

  const report =
    fromMonth !== undefined || toMonth !== undefined
      ? await reportsService.getMonthlyRangeReport(req.user!, orgId, fromMonth, toMonth)
      : await reportsService.getMonthlyReport(
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
  const fromYear = req.query.from_year as string | undefined;
  const toYear = req.query.to_year as string | undefined;

  if (yearRaw !== undefined && !Number.isInteger(Number(yearRaw))) {
    res.status(400).json({ message: "year noto'g'ri" });
    return;
  }

  const report =
    fromYear !== undefined || toYear !== undefined
      ? await reportsService.getYearlyRangeReport(req.user!, orgId, fromYear, toYear)
      : await reportsService.getYearlyReport(
          req.user!,
          orgId,
          yearRaw !== undefined ? Number(yearRaw) : undefined
        );
  res.json(report);
}
