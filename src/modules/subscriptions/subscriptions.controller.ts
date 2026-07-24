import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as subscriptionsService from "./subscriptions.service";

export async function listHandler(req: Request, res: Response) {
  const planIdRaw = req.query.plan_id as string | undefined;
  if (planIdRaw !== undefined && !Number.isInteger(Number(planIdRaw))) {
    res.status(400).json({ message: "plan_id noto'g'ri" });
    return;
  }

  const status = req.query.status as string | undefined;
  if (status !== undefined && status !== "active" && status !== "expired") {
    res.status(400).json({ message: "status noto'g'ri (active yoki expired)" });
    return;
  }

  const subscriptions = await subscriptionsService.listSubscriptions(req.user!, {
    plan_id: planIdRaw !== undefined ? Number(planIdRaw) : undefined,
    status,
    plate_number: req.query.plate_number as string | undefined,
  });
  res.json({ subscriptions });
}

export async function createHandler(req: Request, res: Response) {
  const { plate_number, plan_id } = req.body ?? {};

  if (!plate_number || plan_id === undefined) {
    res.status(400).json({ message: "plate_number va plan_id majburiy" });
    return;
  }

  const subscription = await subscriptionsService.createSubscription(req.user!, { plate_number, plan_id });
  res.status(201).json({ subscription });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { end_date } = req.body ?? {};

  const subscription = await subscriptionsService.updateSubscription(req.user!, id, { end_date });
  res.json({ subscription });
}

export async function deleteHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  await subscriptionsService.deleteSubscription(req.user!, id);
  res.status(204).send();
}

export async function renewHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const subscription = await subscriptionsService.renewSubscription(req.user!, id);
  res.json({ subscription });
}
