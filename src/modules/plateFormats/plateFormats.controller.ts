import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as service from "./plateFormats.service";

function formatId(req: Request, res: Response): number | null {
  const id = Number(req.params.formatId);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ message: "formatId noto'g'ri" });
    return null;
  }
  return id;
}

export async function listHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  res.json({ formats: await service.listPlateFormats(req.user!, orgId) });
}

export async function createHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const format = await service.createPlateFormat(req.user!, orgId, {
    pattern: req.body?.pattern,
    description: req.body?.description,
  });
  res.status(201).json({ format });
}

export async function updateHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const id = formatId(req, res);
  if (id === null) return;
  const format = await service.updatePlateFormat(req.user!, orgId, id, {
    pattern: req.body?.pattern,
    description: req.body?.description,
    is_active: req.body?.is_active,
  });
  res.json({ format });
}

export async function deleteHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const id = formatId(req, res);
  if (id === null) return;
  await service.deletePlateFormat(req.user!, orgId, id);
  res.status(204).send();
}

export async function getSettingHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  res.json(await service.getPlateFormatValidationSetting(req.user!, orgId));
}

export async function updateSettingHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  res.json(
    await service.updatePlateFormatValidationSetting(req.user!, orgId, req.body?.enabled)
  );
}
