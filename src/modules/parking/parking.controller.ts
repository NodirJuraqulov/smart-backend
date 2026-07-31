import { Request, Response } from "express";
import { logActivity } from "@/utils/activityLog";
import {
  parseId,
  parseOptionalOrgIdFromBody,
  parseOptionalOrgIdFromQuery,
  parsePaymentMethod,
} from "@/utils/httpParams";
import * as parkingService from "./parking.service";

export async function entryManualHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromBody(req, res);
  if (orgId === null) return;

  const { plate_number } = req.body ?? {};
  if (!plate_number) {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }

  const session = await parkingService.entryManual(req.user!, { org_id: orgId, plate_number });
  res.status(201).json({ session });
}

export async function exitManualHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromBody(req, res);
  if (orgId === null) return;
  const paymentMethod = parsePaymentMethod(req, res);
  if (paymentMethod === null) return;

  const { plate_number } = req.body ?? {};
  if (!plate_number) {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }

  const result = await parkingService.exitManual(req.user!, {
    org_id: orgId,
    plate_number,
    payment_method: paymentMethod,
  });
  res.status(200).json(result);
}

export async function capacityHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const capacity = await parkingService.getCapacity(req.user!, orgId);
  res.json(capacity);
}

export async function activeHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const sessions = await parkingService.listActive(req.user!, orgId);
  res.json({ sessions });
}

export async function awaitingPaymentHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const sessions = await parkingService.listAwaitingPayment(req.user!, orgId);
  res.json({ sessions });
}

export async function confirmCashPaymentHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const result = await parkingService.confirmCashPayment(req.user!, id);
  res.json(result);
}

export async function sessionsHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;

  const page = req.query.page !== undefined ? Number(req.query.page) : 1;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;

  if (!Number.isInteger(page) || page < 1) {
    res.status(400).json({ message: "page noto'g'ri" });
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "limit noto'g'ri (1-100 oralig'ida bo'lishi kerak)" });
    return;
  }

  const status = req.query.status as string | undefined;
  if (status !== undefined && status !== "active" && status !== "completed") {
    res.status(400).json({ message: "status noto'g'ri (active yoki completed)" });
    return;
  }

  const date = req.query.date as string | undefined;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ message: "date formati noto'g'ri (YYYY-MM-DD)" });
    return;
  }

  const result = await parkingService.listSessions(req.user!, {
    org_id: orgId,
    date,
    plate_number: req.query.plate_number as string | undefined,
    status,
    page,
    limit,
  });
  res.json(result);
}

export async function sessionDetailHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const session = await parkingService.getSessionById(req.user!, id);
  res.json({ session });
}

export async function sessionImageHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  const kind = req.params.kind;
  if (
    kind !== "entry-overview" &&
    kind !== "entry-vehicle" &&
    kind !== "entry-plate" &&
    kind !== "exit-overview" &&
    kind !== "exit-vehicle" &&
    kind !== "exit-plate"
  ) {
    res.status(404).json({ message: "Rasm turi topilmadi" });
    return;
  }
  const absolutePath = await parkingService.getSessionImage(req.user!, id, kind);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(absolutePath);
}

export async function updatePaymentMethodHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { payment_method } = req.body ?? {};
  if (payment_method !== "cash" && payment_method !== "online") {
    res.status(400).json({ message: "payment_method 'cash' yoki 'online' bo'lishi kerak" });
    return;
  }

  const session = await parkingService.updateSessionPaymentMethod(req.user!, id, payment_method);
  res.json({ session });
}

export async function forceCloseHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { exited_at, amount, payment_method } = req.body ?? {};

  const result = await parkingService.forceCloseSession(req.user!, id, {
    exited_at,
    amount,
    payment_method,
  });

  await logActivity(req.user!.id, "session.force_closed", "session", id, {
    org_id: result.session?.org_id,
    plate_number: result.session?.plate_number,
    exited_at: result.session?.exited_at,
    amount: result.session?.amount,
  });

  res.json(result);
}

export async function openBarrierHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { direction } = req.body ?? {};
  if (direction !== "entry" && direction !== "exit") {
    res.status(400).json({ message: "direction 'entry' yoki 'exit' bo'lishi kerak" });
    return;
  }

  const result = await parkingService.openBarrierForSession(req.user!, id, direction);
  res.json(result);
}

export async function printReceiptHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const result = await parkingService.printReceiptForSession(req.user!, id);
  res.json(result);
}

export async function clearTestSessionsHandler(req: Request, res: Response) {
  const orgId = parseOptionalOrgIdFromQuery(req, res);
  if (orgId === null) return;
  const result = await parkingService.clearAllActiveSessions(req.user!, orgId);
  res.json(result);
}
