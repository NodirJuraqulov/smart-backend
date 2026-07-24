import { Request, Response } from "express";
import { parseId, parseOptionalOrgIdFromQuery } from "@/utils/httpParams";
import * as tariffsService from "./tariffs.service";

export async function listHandler(req: Request, res: Response) {
  const queryOrgId = parseOptionalOrgIdFromQuery(req, res);
  if (queryOrgId === null) return;

  const tariffs = await tariffsService.listTariffs(req.user!, queryOrgId);
  res.json({ tariffs });
}

export async function createHandler(req: Request, res: Response) {
  const { org_id, name, price_per_hour, grace_period_minutes } = req.body ?? {};

  if (!name || price_per_hour === undefined) {
    res.status(400).json({ message: "name va price_per_hour majburiy" });
    return;
  }

  const tariff = await tariffsService.createTariff(req.user!, {
    org_id,
    name,
    price_per_hour,
    grace_period_minutes,
  });
  res.status(201).json({ tariff });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { name, price_per_hour, grace_period_minutes } = req.body ?? {};

  const tariff = await tariffsService.updateTariff(req.user!, id, {
    name,
    price_per_hour,
    grace_period_minutes,
  });
  res.json({ tariff });
}
