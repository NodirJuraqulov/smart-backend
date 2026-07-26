import { Request, Response } from "express";

export function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "id noto'g'ri" });
    return null;
  }
  return id;
}

export function parseOptionalOrgIdFromQuery(req: Request, res: Response): number | undefined | null {
  if (req.query.org_id === undefined) return undefined;
  const orgId = Number(req.query.org_id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "org_id noto'g'ri" });
    return null;
  }
  return orgId;
}

export function parseOptionalOrgIdFromBody(req: Request, res: Response): number | undefined | null {
  if (req.body?.org_id === undefined) return undefined;
  const orgId = Number(req.body.org_id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "org_id noto'g'ri" });
    return null;
  }
  return orgId;
}

export function parsePaymentMethod(req: Request, res: Response): "cash" | "online" | null {
  const value = req.body?.payment_method;
  if (value === undefined) return "cash";
  if (value !== "cash" && value !== "online") {
    res.status(400).json({ message: "payment_method 'cash' yoki 'online' bo'lishi kerak" });
    return null;
  }
  return value;
}

