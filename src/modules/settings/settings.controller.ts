import { Request, Response } from "express";
import { logActivity } from "@/utils/activityLog";
import { parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import * as settingsService from "./settings.service";

export async function getHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const settings = await settingsService.getSettings(req.user!, queryOrgId);
  res.json({ settings });
}

export async function updateHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const { barrier_enabled, barrier_open_seconds, work_hours_enabled, work_start, work_end } = req.body ?? {};

  const orgId = resolveOrgIdRequired(req.user!, queryOrgId);
  const settings = await settingsService.updateSettings(orgId, {
    barrier_enabled,
    barrier_open_seconds,
    work_hours_enabled,
    work_start,
    work_end,
  });

  await logActivity(req.user!.id, "settings.updated", "settings", orgId, req.body ?? {});

  res.json({ settings });
}
