import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as vipVehiclesService from "./vipVehicles.service";

export async function listHandler(req: Request, res: Response) {
  const vehicles = await vipVehiclesService.listVipVehicles(req.user!);
  res.json({ vehicles });
}

export async function createHandler(req: Request, res: Response) {
  const { plate_number, note } = req.body ?? {};

  if (!plate_number) {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }

  const vehicle = await vipVehiclesService.createVipVehicle(req.user!, { plate_number, note });
  res.status(201).json({ vehicle });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { plate_number, note } = req.body ?? {};

  const vehicle = await vipVehiclesService.updateVipVehicle(req.user!, id, { plate_number, note });
  res.json({ vehicle });
}

export async function deleteHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  await vipVehiclesService.deleteVipVehicle(req.user!, id);
  res.status(204).send();
}
