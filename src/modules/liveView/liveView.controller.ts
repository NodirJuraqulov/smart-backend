import { Request, Response } from "express";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import { resolveOrgIdRequired } from "@/utils/orgScope";
import { addViewer } from "@/websocket/liveViewRelay";

export async function liveViewHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const type = req.query.type as string | undefined;
  if (type !== "entry" && type !== "exit") {
    res.status(400).json({ message: "type noto'g'ri (entry yoki exit bo'lishi kerak)" });
    return;
  }

  const orgId = resolveOrgIdRequired(req.user!, queryOrgId);
  await assertOrganizationExists(orgId);

  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  addViewer(orgId, type, res);
}
