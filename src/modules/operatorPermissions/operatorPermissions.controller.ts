import { Request, Response } from "express";
import * as operatorPermissionsService from "./operatorPermissions.service";

function parseOrgId(req: Request, res: Response): number | null {
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "id noto'g'ri" });
    return null;
  }
  return orgId;
}

export async function listHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const permissions = await operatorPermissionsService.listPermissions(orgId);
  res.json({ permissions });
}

export async function updateHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const { permissions } = req.body ?? {};
  if (!Array.isArray(permissions)) {
    res.status(400).json({ message: "permissions massiv bo'lishi kerak" });
    return;
  }

  const updated = await operatorPermissionsService.updatePermissions(orgId, permissions);
  res.json({ permissions: updated });
}
