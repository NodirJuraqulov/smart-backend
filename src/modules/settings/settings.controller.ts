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

  const {
    camera_entry_url,
    camera_exit_url,
    camera_username,
    camera_password,
    barrier_enabled,
    barrier_mode,
    barrier_entry_port,
    barrier_exit_port,
    barrier_open_seconds,
    work_hours_enabled,
    work_start,
    work_end,
  } = req.body ?? {};

  const orgId = resolveOrgIdRequired(req.user!, queryOrgId);
  const settings = await settingsService.updateSettings(orgId, {
    camera_entry_url,
    camera_exit_url,
    camera_username,
    camera_password,
    barrier_enabled,
    barrier_mode,
    barrier_entry_port,
    barrier_exit_port,
    barrier_open_seconds,
    work_hours_enabled,
    work_start,
    work_end,
  });

  // camera_password is deliberately excluded from the logged details — the
  // plaintext must never be written to tb_activity_logs.
  const { camera_password: _cameraPassword, ...loggedBody } = req.body ?? {};
  await logActivity(req.user!.id, "settings.updated", "settings", orgId, loggedBody);

  res.json({ settings });
}

export async function testBarrierHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const type = (req.query.type ?? req.body?.type) as string | undefined;
  if (type !== "entry" && type !== "exit") {
    res.status(400).json({ message: "type noto'g'ri (entry yoki exit bo'lishi kerak)" });
    return;
  }

  const result = await settingsService.testBarrier(req.user!, queryOrgId, type);
  res.json(result);
}

export async function generateAgentKeyHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const orgId = resolveOrgIdRequired(req.user!, queryOrgId);
  const agentApiKey = await settingsService.generateAgentApiKey(orgId);

  await logActivity(req.user!.id, "agent_key.generated", "settings", orgId);

  res.json({ agent_api_key: agentApiKey });
}
