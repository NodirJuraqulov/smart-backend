import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { resolveOrgIdRequired } from "@/utils/orgScope";

interface SettingsRecord {
  id: number;
  org_id: number;
  barrier_enabled: boolean;
  barrier_open_seconds: number;
  work_hours_enabled: boolean;
  work_start: string | null;
  work_end: string | null;
  created_at: Date;
}

interface UpdateSettingsInput {
  barrier_enabled?: boolean;
  barrier_open_seconds?: number;
  work_hours_enabled?: boolean;
  work_start?: string | null;
  work_end?: string | null;
}

async function getOrCreateSettings(orgId: number): Promise<SettingsRecord> {
  const existing = await db<SettingsRecord>("tb_settings").where({ org_id: orgId }).first();
  if (existing) {
    return existing;
  }

  try {
    await db("tb_settings").insert({
      org_id: orgId,
      barrier_enabled: false,
      barrier_open_seconds: 3,
      work_hours_enabled: false,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
  }

  return db<SettingsRecord>("tb_settings").where({ org_id: orgId }).first() as Promise<SettingsRecord>;
}

export async function getSettings(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  return getOrCreateSettings(orgId);
}

export async function updateSettings(orgId: number, input: UpdateSettingsInput) {
  await assertOrganizationExists(orgId);
  await getOrCreateSettings(orgId);

  const updates: Record<string, unknown> = {};
  if (input.barrier_enabled !== undefined) updates.barrier_enabled = input.barrier_enabled;
  if (input.barrier_open_seconds !== undefined) {
    updates.barrier_open_seconds = input.barrier_open_seconds;
  }
  if (input.work_hours_enabled !== undefined) updates.work_hours_enabled = input.work_hours_enabled;
  if (input.work_start !== undefined) updates.work_start = input.work_start;
  if (input.work_end !== undefined) updates.work_end = input.work_end;

  if (Object.keys(updates).length > 0) {
    await db("tb_settings").where({ org_id: orgId }).update(updates);
  }

  return db<SettingsRecord>("tb_settings").where({ org_id: orgId }).first();
}
