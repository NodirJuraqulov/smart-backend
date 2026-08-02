import { Request, Response } from "express";
import { parseId, parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import * as service from "./entryCandidates.service";

export async function nextHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  const result = await service.getNextEntryCandidate(req.user!, orgId);
  if (!result) {
    res.status(204).send();
    return;
  }
  res.json(result);
}

export async function acceptHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  if (typeof req.body?.plate_number !== "string" || !req.body.plate_number.trim()) {
    res.status(400).json({ message: "Davlat raqami kiritilishi kerak" });
    return;
  }
  if (req.body?.note !== undefined && typeof req.body.note !== "string") {
    res.status(400).json({ message: "note matn bo'lishi kerak" });
    return;
  }
  res.json(
    await service.acceptEntryCandidate(req.user!, orgId, id, {
      plateNumber: req.body.plate_number,
      note: req.body?.note,
    })
  );
}

export async function declineHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  if (req.body?.note !== undefined && typeof req.body.note !== "string") {
    res.status(400).json({ message: "note matn bo'lishi kerak" });
    return;
  }
  res.json(await service.declineEntryCandidate(req.user!, orgId, id, req.body?.note));
}

export async function retryEntryBarrierHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  res.json(await service.retryEntryBarrier(req.user!, orgId, id));
}

export async function manualEntryHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  if (typeof req.body?.plate_number !== "string" || !req.body.plate_number.trim()) {
    res.status(400).json({ message: "Davlat raqami kiritilishi kerak" });
    return;
  }
  if (typeof req.body?.reason !== "string" || !req.body.reason.trim()) {
    res.status(400).json({ message: "reason majburiy" });
    return;
  }
  if (req.body?.note !== undefined && typeof req.body.note !== "string") {
    res.status(400).json({ message: "note matn bo'lishi kerak" });
    return;
  }
  res.json(
    await service.createManualEntry(req.user!, orgId, {
      plateNumber: req.body.plate_number,
      reason: req.body.reason,
      note: req.body?.note,
    })
  );
}
