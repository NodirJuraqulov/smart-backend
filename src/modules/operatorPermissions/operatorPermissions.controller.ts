import { Request, Response } from "express";
import * as operatorPermissionsService from "./operatorPermissions.service";
import { PermissionRole, isPermissionRole } from "./operatorPermissions.service";

function parseOrgId(req: Request, res: Response): number | null {
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "id noto'g'ri" });
    return null;
  }
  return orgId;
}

function parseRole(value: unknown, res: Response): PermissionRole | null {
  if (value === undefined) return "operator";
  if (!isPermissionRole(value)) {
    res.status(400).json({ message: "role 'operator' yoki 'kassir' bo'lishi kerak" });
    return null;
  }
  return value;
}

export async function listHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const role = parseRole(req.query.role, res);
  if (role === null) return;

  const permissions = await operatorPermissionsService.listPermissions(orgId, role);
  res.json({ role, permissions });
}

export async function updateHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const role = parseRole(req.body?.role, res);
  if (role === null) return;

  const { permissions } = req.body ?? {};
  if (!Array.isArray(permissions)) {
    res.status(400).json({ message: "permissions massiv bo'lishi kerak" });
    return;
  }

  const updated = await operatorPermissionsService.updatePermissions(orgId, permissions, role);
  res.json({ role, permissions: updated });
}
