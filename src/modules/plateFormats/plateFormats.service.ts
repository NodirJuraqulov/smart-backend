import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { logActivity } from "@/utils/activityLog";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdRequired } from "@/utils/orgScope";

export interface PlateFormat {
  id: number;
  org_id: number;
  pattern: string;
  description: string | null;
  is_active: boolean | 0 | 1;
  created_at: Date;
}

interface PlateFormatInput {
  pattern: unknown;
  description?: unknown;
}

interface PlateFormatPatch {
  pattern?: unknown;
  description?: unknown;
  is_active?: unknown;
}

const PLATE_PATTERN = /^[NL]+$/;
const MAX_PATTERN_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 255;

function normalizedPattern(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError("pattern majburiy va matn bo'lishi kerak", 400);
  }
  const pattern = value.trim().toUpperCase();
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || !PLATE_PATTERN.test(pattern)) {
    throw new ApiError("pattern faqat N va L belgilaridan iborat, 1-20 uzunlikda bo'lishi kerak", 400);
  }
  return pattern;
}

function normalizedDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError("description matn yoki null bo'lishi kerak", 400);
  }
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ApiError("description 255 belgidan oshmasligi kerak", 400);
  }
  return description || null;
}

async function accessibleOrgId(actor: AuthTokenPayload, requestedOrgId: number): Promise<number> {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  const organization = await db("tb_organizations").select("id").where({ id: orgId }).first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
  return orgId;
}

async function findFormatOrFail(orgId: number, formatId: number): Promise<PlateFormat> {
  const format = await db<PlateFormat>("tb_plate_formats")
    .where({ id: formatId, org_id: orgId })
    .first();
  if (!format) throw new ApiError("Davlat raqami formati topilmadi", 404);
  return format;
}

function serializeFormat(format: PlateFormat) {
  return { ...format, is_active: Boolean(format.is_active) };
}

export function isValidPlateFormat(plate: string, formats: PlateFormat[]): boolean {
  const activeFormats = formats.filter((format) => Boolean(format.is_active));
  if (activeFormats.length === 0) return true;
  const normalized = plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized) return false;
  return activeFormats.some((format) => {
    if (format.pattern.length !== normalized.length) return false;
    for (let index = 0; index < format.pattern.length; index += 1) {
      const token = format.pattern[index];
      const character = normalized[index];
      if (token === "N" ? !/[0-9]/.test(character) : !/[A-Z]/.test(character)) return false;
    }
    return true;
  });
}

export async function getActivePlateFormats(orgId: number): Promise<PlateFormat[]> {
  return db<PlateFormat>("tb_plate_formats")
    .where({ org_id: orgId, is_active: true })
    .orderBy("id", "asc");
}

export async function listPlateFormats(actor: AuthTokenPayload, requestedOrgId: number) {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  const formats = await db<PlateFormat>("tb_plate_formats")
    .where({ org_id: orgId })
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
  return formats.map(serializeFormat);
}

export async function createPlateFormat(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  input: PlateFormatInput
) {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  const pattern = normalizedPattern(input.pattern);
  const description = normalizedDescription(input.description);
  try {
    const [formatId] = await db("tb_plate_formats").insert({
      org_id: orgId,
      pattern,
      description,
      is_active: true,
    });
    await logActivity(actor.id, "organization.plate_format_created", "plate_format", formatId, {
      orgId,
      pattern,
      description,
    });
    return serializeFormat(await findFormatOrFail(orgId, formatId));
  } catch (error) {
    if (isDuplicateKeyError(error, "uq_plate_formats_org_pattern")) {
      throw new ApiError("Bu format tashkilot uchun allaqachon mavjud", 409);
    }
    throw error;
  }
}

export async function updatePlateFormat(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  formatId: number,
  input: PlateFormatPatch
) {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  await findFormatOrFail(orgId, formatId);
  const updates: { pattern?: string; description?: string | null; is_active?: boolean } = {};
  if (input.pattern !== undefined) updates.pattern = normalizedPattern(input.pattern);
  if (input.description !== undefined) updates.description = normalizedDescription(input.description);
  if (input.is_active !== undefined) {
    if (typeof input.is_active !== "boolean") {
      throw new ApiError("is_active boolean bo'lishi kerak", 400);
    }
    updates.is_active = input.is_active;
  }
  if (Object.keys(updates).length === 0) {
    throw new ApiError("Kamida bitta tahrirlanadigan maydon yuborilishi kerak", 400);
  }
  try {
    await db("tb_plate_formats").where({ id: formatId, org_id: orgId }).update(updates);
  } catch (error) {
    if (isDuplicateKeyError(error, "uq_plate_formats_org_pattern")) {
      throw new ApiError("Bu format tashkilot uchun allaqachon mavjud", 409);
    }
    throw error;
  }
  await logActivity(actor.id, "organization.plate_format_updated", "plate_format", formatId, {
    orgId,
    ...updates,
  });
  return serializeFormat(await findFormatOrFail(orgId, formatId));
}

export async function deletePlateFormat(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  formatId: number
): Promise<void> {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  const format = await findFormatOrFail(orgId, formatId);
  await db("tb_plate_formats").where({ id: formatId, org_id: orgId }).del();
  await logActivity(actor.id, "organization.plate_format_deleted", "plate_format", formatId, {
    orgId,
    pattern: format.pattern,
  });
}

export async function getPlateFormatValidationSetting(
  actor: AuthTokenPayload,
  requestedOrgId: number
): Promise<{ enabled: boolean }> {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  const organization = await db("tb_organizations")
    .select("plate_format_validation_enabled")
    .where({ id: orgId })
    .first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
  return { enabled: !!organization.plate_format_validation_enabled };
}

export async function updatePlateFormatValidationSetting(
  actor: AuthTokenPayload,
  requestedOrgId: number,
  enabled: unknown
): Promise<{ enabled: boolean }> {
  const orgId = await accessibleOrgId(actor, requestedOrgId);
  if (typeof enabled !== "boolean") {
    throw new ApiError("enabled boolean bo'lishi kerak", 400);
  }
  await db.transaction(async (trx) => {
    await trx("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: enabled });
    if (!enabled) await trx("tb_plate_format_checks").where({ org_id: orgId }).del();
  });
  await logActivity(
    actor.id,
    "organization.plate_format_validation_updated",
    "organization",
    orgId,
    { orgId, enabled }
  );
  return { enabled };
}
