import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as subscriptionPlansService from "./subscriptionPlans.service";

export async function listHandler(req: Request, res: Response) {
  const plans = await subscriptionPlansService.listPlans(req.user!);
  res.json({ plans });
}

export async function createHandler(req: Request, res: Response) {
  const { name, duration_days, price } = req.body ?? {};

  if (!name || duration_days === undefined || price === undefined) {
    res.status(400).json({ message: "name, duration_days va price majburiy" });
    return;
  }

  const plan = await subscriptionPlansService.createPlan(req.user!, { name, duration_days, price });
  res.status(201).json({ plan });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { name, duration_days, price, is_blocked } = req.body ?? {};

  const plan = await subscriptionPlansService.updatePlan(req.user!, id, {
    name,
    duration_days,
    price,
    is_blocked,
  });
  res.json({ plan });
}

export async function deleteHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  await subscriptionPlansService.deletePlan(req.user!, id);
  res.status(204).send();
}
