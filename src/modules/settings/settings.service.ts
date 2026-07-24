import { randomBytes } from "crypto";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { decrypt, encrypt } from "@/utils/encryption";
import { resolveOrgIdRequired } from "@/utils/orgScope";

interface SettingsRecord {
  id: number;
  org_id: number;
  camera_entry_url: string | null;
  camera_exit_url: string | null;
  camera_username: string | null;
  camera_password_encrypted: string | null;
  barrier_enabled: boolean;
  barrier_mode: "single" | "separate";
  barrier_entry_port: string | null;
  barrier_exit_port: string | null;
  barrier_open_seconds: number;
  work_hours_enabled: boolean;
  work_start: string | null;
  work_end: string | null;
  agent_api_key: string | null;
  last_heartbeat_at: Date | null;
  last_camera_entry_ok: boolean | null;
  last_camera_exit_ok: boolean | null;
  created_at: Date;
}

interface UpdateSettingsInput {
  camera_entry_url?: string | null;
  camera_exit_url?: string | null;
  camera_username?: string | null;
  camera_password?: string | null;
  barrier_enabled?: boolean;
  barrier_mode?: "single" | "separate";
  barrier_entry_port?: string | null;
  barrier_exit_port?: string | null;
  barrier_open_seconds?: number;
  work_hours_enabled?: boolean;
  work_start?: string | null;
  work_end?: string | null;
}

function maskCameraPassword<T extends { camera_password_encrypted: string | null }>(
  settings: T
): Omit<T, "camera_password_encrypted"> & { camera_password_configured: boolean } {
  const { camera_password_encrypted, ...rest } = settings;
  return { ...rest, camera_password_configured: camera_password_encrypted !== null };
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
  const settings = await getOrCreateSettings(orgId);
  const masked = maskCameraPassword(settings);

  if (actor.role === "operator") {
    return { ...masked, agent_api_key: null };
  }

  return masked;
}

export async function updateSettings(orgId: number, input: UpdateSettingsInput) {
  await assertOrganizationExists(orgId);
  await getOrCreateSettings(orgId);

  const updates: Record<string, unknown> = {};
  if (input.camera_entry_url !== undefined) updates.camera_entry_url = input.camera_entry_url;
  if (input.camera_exit_url !== undefined) updates.camera_exit_url = input.camera_exit_url;
  if (input.camera_username !== undefined) updates.camera_username = input.camera_username;
  if (input.camera_password !== undefined) {
    updates.camera_password_encrypted = input.camera_password !== null ? encrypt(input.camera_password) : null;
  }
  if (input.barrier_enabled !== undefined) updates.barrier_enabled = input.barrier_enabled;
  if (input.barrier_mode !== undefined) updates.barrier_mode = input.barrier_mode;
  if (input.barrier_entry_port !== undefined) updates.barrier_entry_port = input.barrier_entry_port;
  if (input.barrier_exit_port !== undefined) updates.barrier_exit_port = input.barrier_exit_port;
  if (input.barrier_open_seconds !== undefined) {
    updates.barrier_open_seconds = input.barrier_open_seconds;
  }
  if (input.work_hours_enabled !== undefined) updates.work_hours_enabled = input.work_hours_enabled;
  if (input.work_start !== undefined) updates.work_start = input.work_start;
  if (input.work_end !== undefined) updates.work_end = input.work_end;

  if (Object.keys(updates).length > 0) {
    await db("tb_settings").where({ org_id: orgId }).update(updates);
  }

  const settings = await db<SettingsRecord>("tb_settings").where({ org_id: orgId }).first();
  return maskCameraPassword(settings!);
}

export async function testBarrier(
  actor: AuthTokenPayload,
  requestedOrgId: number | undefined,
  type: "entry" | "exit"
) {
  const orgId = resolveOrgIdRequired(actor, requestedOrgId);
  await assertOrganizationExists(orgId);
  const settings = await getOrCreateSettings(orgId);

  if (!settings.barrier_enabled) {
    throw new ApiError(
      "Shlagbaum ulanmagan (barrier_enabled: false) — avval sozlamalarda yoqing",
      400
    );
  }

  const port = settings.barrier_mode === "separate" && type === "exit"
    ? settings.barrier_exit_port
    : settings.barrier_entry_port;

  return {
    message: "Test signali yuborildi — shlagbaum ochilib, belgilangan vaqtdan so'ng yopiladi",
    org_id: orgId,
    type,
    barrier_port: port,
    barrier_open_seconds: settings.barrier_open_seconds,
  };
}

export async function getAgentConfig(orgId: number) {
  const settings = await getOrCreateSettings(orgId);
  return {
    camera_entry_url: settings.camera_entry_url,
    camera_exit_url: settings.camera_exit_url,
    camera_username: settings.camera_username,
    camera_password: settings.camera_password_encrypted
      ? decrypt(settings.camera_password_encrypted)
      : null,
    barrier_enabled: settings.barrier_enabled,
    barrier_mode: settings.barrier_mode,
    barrier_entry_port: settings.barrier_entry_port,
    barrier_exit_port: settings.barrier_exit_port,
    barrier_open_seconds: settings.barrier_open_seconds,
  };
}

export async function recordHeartbeat(
  orgId: number,
  cameraEntryOk: boolean | null | undefined,
  cameraExitOk: boolean | null | undefined
): Promise<void> {
  await getOrCreateSettings(orgId);

  const updates: Record<string, unknown> = { last_heartbeat_at: new Date() };
  if (cameraEntryOk !== undefined) updates.last_camera_entry_ok = cameraEntryOk;
  if (cameraExitOk !== undefined) updates.last_camera_exit_ok = cameraExitOk;

  await db("tb_settings").where({ org_id: orgId }).update(updates);
}

export async function generateAgentApiKey(orgId: number): Promise<string> {
  await assertOrganizationExists(orgId);
  await getOrCreateSettings(orgId);

  const agentApiKey = randomBytes(32).toString("hex");

  try {
    await db("tb_settings").where({ org_id: orgId }).update({ agent_api_key: agentApiKey });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new ApiError("Kalit generatsiyasida xatolik, qayta urinib ko'ring", 409);
    }
    throw err;
  }

  return agentApiKey;
}
