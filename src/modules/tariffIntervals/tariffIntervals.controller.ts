import { Request, Response } from "express";
import * as tariffIntervalsService from "./tariffIntervals.service";

function parseOrgId(req: Request, res: Response): number | null {
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "id noto'g'ri" });
    return null;
  }
  return orgId;
}

function parseIntervalId(req: Request, res: Response): number | null {
  const intervalId = Number(req.params.intervalId);
  if (!Number.isInteger(intervalId)) {
    res.status(400).json({ message: "intervalId noto'g'ri" });
    return null;
  }
  return intervalId;
}

export async function listHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const intervals = await tariffIntervalsService.listTariffIntervals(orgId);
  res.json({ intervals });
}

export async function createHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;

  const { from_minutes, to_minutes, price } = req.body ?? {};

  if (from_minutes === undefined || price === undefined) {
    res.status(400).json({ message: "from_minutes va price majburiy" });
    return;
  }

  const interval = await tariffIntervalsService.createTariffInterval(orgId, {
    from_minutes,
    to_minutes,
    price,
  });
  res.status(201).json({ interval });
}

export async function updateHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;
  const intervalId = parseIntervalId(req, res);
  if (intervalId === null) return;

  const { from_minutes, to_minutes, price } = req.body ?? {};

  const interval = await tariffIntervalsService.updateTariffInterval(orgId, intervalId, {
    from_minutes,
    to_minutes,
    price,
  });
  res.json({ interval });
}

export async function deleteHandler(req: Request, res: Response) {
  const orgId = parseOrgId(req, res);
  if (orgId === null) return;
  const intervalId = parseIntervalId(req, res);
  if (intervalId === null) return;

  await tariffIntervalsService.deleteTariffInterval(orgId, intervalId);
  res.status(204).send();
}
