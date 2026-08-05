import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import * as medplusService from "./medplus.service";

export async function discountWebhookHandler(req: Request, res: Response) {
  const orgId = req.medplusOrgId!;
  const { plate_number, source_reference } = req.body ?? {};

  if (!plate_number || typeof plate_number !== "string") {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }
  if (source_reference !== undefined && typeof source_reference !== "string") {
    res.status(400).json({ message: "source_reference matn bo'lishi kerak" });
    return;
  }

  const result = await medplusService.createClinicDiscount(orgId, plate_number, source_reference ?? null);
  res.status(200).json({ success: true, discount_id: result.id });
}

export async function inpatientWebhookHandler(req: Request, res: Response) {
  const orgId = req.medplusOrgId!;
  const { plate_number, duration_days, patient_reference, patient_name } = req.body ?? {};

  if (!plate_number || typeof plate_number !== "string") {
    res.status(400).json({ message: "plate_number majburiy" });
    return;
  }
  if (!Number.isInteger(duration_days) || duration_days <= 0) {
    res.status(400).json({ message: "duration_days musbat butun son bo'lishi kerak" });
    return;
  }
  if (patient_reference !== undefined && typeof patient_reference !== "string") {
    res.status(400).json({ message: "patient_reference matn bo'lishi kerak" });
    return;
  }
  if (patient_name !== undefined && typeof patient_name !== "string") {
    res.status(400).json({ message: "patient_name matn bo'lishi kerak" });
    return;
  }

  const result = await medplusService.upsertInpatientVehicle(orgId, {
    plateNumber: plate_number,
    durationDays: duration_days,
    patientReference: patient_reference ?? null,
    patientName: patient_name ?? null,
  });
  res.status(200).json({ success: true, inpatient_id: result.id, valid_until: result.validUntil });
}

function parseStatusFilter<T extends string>(req: Request, res: Response, allowed: T): T | "all" | null {
  const value = req.query.status;
  if (value === undefined || value === "all") return "all";
  if (value === allowed) return allowed;
  res.status(400).json({ message: "status noto'g'ri" });
  return null;
}

function parsePagination(req: Request, res: Response): { page: number; limit: number } | null {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ message: "page va limit noto'g'ri" });
    return null;
  }
  return { page, limit };
}

export async function listClinicDiscountsHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const status = parseStatusFilter(req, res, "pending");
  if (status === null) return;
  const paginationInput = parsePagination(req, res);
  if (!paginationInput) return;

  res.json(await medplusService.listClinicDiscounts(req.user!, orgId, { status, ...paginationInput }));
}

export async function cancelClinicDiscountHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const discountId = Number(req.params.discountId);
  if (!Number.isInteger(discountId)) {
    res.status(400).json({ message: "discountId noto'g'ri" });
    return;
  }

  const discount = await medplusService.cancelClinicDiscount(req.user!, orgId, discountId);
  res.json({ discount });
}

export async function listInpatientVehiclesHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const status = parseStatusFilter(req, res, "active");
  if (status === null) return;
  const paginationInput = parsePagination(req, res);
  if (!paginationInput) return;

  res.json(await medplusService.listInpatientVehicles(req.user!, orgId, { status, ...paginationInput }));
}

export async function cancelInpatientVehicleHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const vehicleId = Number(req.params.vehicleId);
  if (!Number.isInteger(vehicleId)) {
    res.status(400).json({ message: "vehicleId noto'g'ri" });
    return;
  }

  const vehicle = await medplusService.cancelInpatientVehicle(req.user!, orgId, vehicleId);
  res.json({ vehicle });
}

export async function getClinicDiscountSettingsHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  res.json(await medplusService.getClinicDiscountSettings(req.user!, orgId));
}

export async function updateClinicDiscountSettingsHandler(req: Request, res: Response) {
  const orgId = parseId(req, res);
  if (orgId === null) return;
  const { clinic_discount_percent } = req.body ?? {};
  if (typeof clinic_discount_percent !== "number") {
    res.status(400).json({ message: "clinic_discount_percent majburiy" });
    return;
  }

  res.json(await medplusService.updateClinicDiscountSettings(req.user!, orgId, clinic_discount_percent));
}
