import { db } from "@/config/db";
import { decryptSecret } from "@/utils/encryption";
import { openRelay } from "./dahuaRelay.service";

export type BarrierStatus = "opened" | "disabled" | "not_configured" | "failed";

export interface BarrierResult {
  status: BarrierStatus;
  success: boolean;
  detail?: string;
}

interface RelayOrganizationRow {
  id: number;
  entry_camera_relay_host: string | null;
  entry_camera_relay_port: number | null;
  entry_camera_relay_username: string | null;
  entry_camera_relay_password_encrypted: string | null;
  entry_camera_relay_channel: number | null;
  exit_camera_relay_host: string | null;
  exit_camera_relay_port: number | null;
  exit_camera_relay_username: string | null;
  exit_camera_relay_password_encrypted: string | null;
  exit_camera_relay_channel: number | null;
}

export async function openBarrier(orgId: number, direction: "entry" | "exit"): Promise<BarrierResult> {
  const organization = await db<RelayOrganizationRow>("tb_organizations")
    .select(
      "entry_camera_relay_host",
      "entry_camera_relay_port",
      "entry_camera_relay_username",
      "entry_camera_relay_password_encrypted",
      "entry_camera_relay_channel",
      "exit_camera_relay_host",
      "exit_camera_relay_port",
      "exit_camera_relay_username",
      "exit_camera_relay_password_encrypted",
      "exit_camera_relay_channel"
    )
    .where({ id: orgId })
    .first();
  const prefix = direction === "entry" ? "entry" : "exit";
  const host = organization?.[`${prefix}_camera_relay_host`];
  const username = organization?.[`${prefix}_camera_relay_username`];
  const encryptedPassword = organization?.[`${prefix}_camera_relay_password_encrypted`];
  if (!host || !username || !encryptedPassword) {
    return {
      status: "not_configured",
      success: false,
      detail: "Kamera relay sozlamalari to'liq konfiguratsiya qilinmagan",
    };
  }
  let password: string;
  try {
    password = decryptSecret(encryptedPassword);
  } catch (err) {
    return {
      status: "failed",
      success: false,
      detail: `Kamera relay parolini o'qib bo'lmadi: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = await openRelay({
    host,
    port: organization?.[`${prefix}_camera_relay_port`],
    username,
    password,
    channel: organization?.[`${prefix}_camera_relay_channel`],
  });
  return { ...result, success: result.status === "opened" };
}
