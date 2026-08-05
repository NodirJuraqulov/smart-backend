import { DateTime } from "luxon";
import type { Knex } from "knex";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { logActivity } from "@/utils/activityLog";
import { resolveOrgIdRequired } from "@/utils/orgScope";

export type ClinicDiscountStatus = "pending" | "used" | "expired" | "cancelled";
export type InpatientVehicleStatus = "active" | "expired" | "cancelled";

export interface ClinicDiscountRow {
  id: number;
  org_id: number;
  plate_number: string;
  discount_percent: number;
  status: ClinicDiscountStatus;
  source_reference: string | null;
  created_at: Date;
  used_at: Date | null;
  used_session_id: number | null;
  cancelled_by: number | null;
  cancelled_at: Date | null;
}

export interface InpatientVehicleRow {
  id: number;
  org_id: number;
  plate_number: string;
  patient_reference: string | null;
  patient_name: string | null;
  valid_from: string;
  valid_until: string;
  status: InpatientVehicleStatus;
  created_at: Date;
  cancelled_by: number | null;
  cancelled_at: Date | null;
}

export function normalizePlate(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function getOrgTodayRange(timezone: string | null | undefined): { start: Date; end: Date } {
  const start = DateTime.now().setZone(timezone || undefined).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

export function getOrgTodayDate(timezone: string | null | undefined): string {
  return DateTime.now().setZone(timezone || undefined).toFormat("yyyy-MM-dd");
}

export async function createClinicDiscount(
  orgId: number,
  plateNumberRaw: string,
  sourceReference: string | null
): Promise<{ id: number; created: boolean }> {
  const plateNumber = normalizePlate(plateNumberRaw);
  if (!plateNumber) {
    throw new ApiError("plate_number noto'g'ri", 400);
  }

  return db.transaction(async (trx) => {
    const organization = await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    if (!organization) {
      throw new ApiError("Stoyanka topilmadi", 404);
    }

    const { start, end } = getOrgTodayRange(organization.timezone);
    const existing = await trx<ClinicDiscountRow>("tb_clinic_discounts")
      .where({ org_id: orgId, plate_number: plateNumber, status: "pending" })
      .andWhere("created_at", ">=", start)
      .andWhere("created_at", "<", end)
      .orderBy("created_at", "desc")
      .first();
    if (existing) {
      return { id: existing.id, created: false };
    }

    const [id] = await trx("tb_clinic_discounts").insert({
      org_id: orgId,
      plate_number: plateNumber,
      discount_percent: organization.clinic_discount_percent,
      status: "pending",
      source_reference: sourceReference,
    });
    return { id, created: true };
  });
}

export async function upsertInpatientVehicle(
  orgId: number,
  input: {
    plateNumber: string;
    durationDays: number;
    patientReference: string | null;
    patientName: string | null;
  }
): Promise<{ id: number; validUntil: string; created: boolean }> {
  const plateNumber = normalizePlate(input.plateNumber);
  if (!plateNumber) {
    throw new ApiError("plate_number noto'g'ri", 400);
  }
  if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
    throw new ApiError("duration_days musbat butun son bo'lishi kerak", 400);
  }

  return db.transaction(async (trx) => {
    const organization = await trx("tb_organizations").where({ id: orgId }).forUpdate().first();
    if (!organization) {
      throw new ApiError("Stoyanka topilmadi", 404);
    }

    const validFrom = getOrgTodayDate(organization.timezone);
    const validUntil = DateTime.fromFormat(validFrom, "yyyy-MM-dd")
      .plus({ days: input.durationDays })
      .toFormat("yyyy-MM-dd");

    const existing = await trx<InpatientVehicleRow>("tb_inpatient_vehicles")
      .where({ org_id: orgId, plate_number: plateNumber, status: "active" })
      .forUpdate()
      .first();
    if (existing) {
      await trx("tb_inpatient_vehicles").where({ id: existing.id }).update({ valid_until: validUntil });
      return { id: existing.id, validUntil, created: false };
    }

    const [id] = await trx("tb_inpatient_vehicles").insert({
      org_id: orgId,
      plate_number: plateNumber,
      patient_reference: input.patientReference,
      patient_name: input.patientName,
      valid_from: validFrom,
      valid_until: validUntil,
      status: "active",
    });
    return { id, validUntil, created: true };
  });
}

export async function findActiveInpatientVehicleForExit(
  orgId: number,
  plateNumber: string,
  todayDate: string,
  executor: Knex
): Promise<InpatientVehicleRow | undefined> {
  return executor<InpatientVehicleRow>("tb_inpatient_vehicles")
    .where({ org_id: orgId, plate_number: normalizePlate(plateNumber), status: "active" })
    .andWhere("valid_until", ">=", todayDate)
    .first();
}

export async function findPendingClinicDiscountForExit(
  orgId: number,
  plateNumber: string,
  todayRange: { start: Date; end: Date },
  executor: Knex
): Promise<ClinicDiscountRow | undefined> {
  return executor<ClinicDiscountRow>("tb_clinic_discounts")
    .where({ org_id: orgId, plate_number: normalizePlate(plateNumber), status: "pending" })
    .andWhere("created_at", ">=", todayRange.start)
    .andWhere("created_at", "<", todayRange.end)
    .orderBy("created_at", "desc")
    .first();
}

export async function markClinicDiscountUsed(
  discountId: number,
  sessionId: number,
  usedAt: Date,
  executor: Knex
): Promise<void> {
  await executor("tb_clinic_discounts")
    .where({ id: discountId })
    .update({ status: "used", used_at: usedAt, used_session_id: sessionId });
}

function pagination(input: { page: number; limit: number }, total: number) {
  return {
    page: input.page,
    limit: input.limit,
    total,
    total_pages: Math.ceil(total / input.limit) || 1,
  };
}

export async function listClinicDiscounts(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { status: "pending" | "all"; page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const query = db<ClinicDiscountRow>("tb_clinic_discounts").where({ org_id: orgId });
  if (input.status === "pending") {
    query.andWhere({ status: "pending" });
  }
  const [{ count }] = await query.clone().count<{ count: string }[]>("id as count");
  const discounts = await query
    .clone()
    .orderBy("created_at", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  return { discounts, pagination: pagination(input, Number(count)) };
}

export async function cancelClinicDiscount(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  discountId: number
): Promise<ClinicDiscountRow> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const discount = await db<ClinicDiscountRow>("tb_clinic_discounts")
    .where({ id: discountId, org_id: orgId })
    .first();
  if (!discount) {
    throw new ApiError("Chegirma topilmadi", 404);
  }
  if (discount.status !== "pending") {
    throw new ApiError("Faqat kutilayotgan chegirmani bekor qilish mumkin", 409);
  }

  const cancelledAt = new Date();
  await db("tb_clinic_discounts")
    .where({ id: discountId })
    .update({ status: "cancelled", cancelled_by: actor.id, cancelled_at: cancelledAt });
  await logActivity(actor.id, "clinic_discount.cancelled", "clinic_discount", discountId, {
    orgId,
    plateNumber: discount.plate_number,
  });

  return { ...discount, status: "cancelled", cancelled_by: actor.id, cancelled_at: cancelledAt };
}

export async function listInpatientVehicles(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  input: { status: "active" | "all"; page: number; limit: number }
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const query = db<InpatientVehicleRow>("tb_inpatient_vehicles").where({ org_id: orgId });
  if (input.status === "active") {
    query.andWhere({ status: "active" });
  }
  const [{ count }] = await query.clone().count<{ count: string }[]>("id as count");
  const vehicles = await query
    .clone()
    .orderBy("created_at", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  return { vehicles, pagination: pagination(input, Number(count)) };
}

export async function cancelInpatientVehicle(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  vehicleId: number
): Promise<InpatientVehicleRow> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const vehicle = await db<InpatientVehicleRow>("tb_inpatient_vehicles")
    .where({ id: vehicleId, org_id: orgId })
    .first();
  if (!vehicle) {
    throw new ApiError("Statsionar mashina topilmadi", 404);
  }
  if (vehicle.status !== "active") {
    throw new ApiError("Faqat faol yozuvni bekor qilish mumkin", 409);
  }

  const cancelledAt = new Date();
  await db("tb_inpatient_vehicles")
    .where({ id: vehicleId })
    .update({ status: "cancelled", cancelled_by: actor.id, cancelled_at: cancelledAt });
  await logActivity(actor.id, "inpatient_vehicle.cancelled", "inpatient_vehicle", vehicleId, {
    orgId,
    plateNumber: vehicle.plate_number,
  });

  return { ...vehicle, status: "cancelled", cancelled_by: actor.id, cancelled_at: cancelledAt };
}

export async function getClinicDiscountSettings(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined
): Promise<{ clinic_discount_percent: number }> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const organization = await db("tb_organizations")
    .select("clinic_discount_percent")
    .where({ id: orgId })
    .first();
  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
  return { clinic_discount_percent: organization.clinic_discount_percent };
}

export async function updateClinicDiscountSettings(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  clinicDiscountPercent: number
): Promise<{ clinic_discount_percent: number }> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  if (
    !Number.isInteger(clinicDiscountPercent) ||
    clinicDiscountPercent < 0 ||
    clinicDiscountPercent > 100
  ) {
    throw new ApiError("clinic_discount_percent 0 dan 100 gacha bo'lishi kerak", 400);
  }
  const organization = await db("tb_organizations").select("id").where({ id: orgId }).first();
  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
  await db("tb_organizations").where({ id: orgId }).update({ clinic_discount_percent: clinicDiscountPercent });
  await logActivity(actor.id, "organization.clinic_discount_percent_updated", "organization", orgId, {
    clinicDiscountPercent,
  });
  return { clinic_discount_percent: clinicDiscountPercent };
}
