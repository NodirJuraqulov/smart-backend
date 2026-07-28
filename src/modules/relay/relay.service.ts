import { db } from "@/config/db";

const RELAY_TIMEOUT_MS = 5000;
const DEFAULT_OPEN_SECONDS = 5;

export type BarrierStatus = "opened" | "disabled" | "not_configured" | "failed";

export interface BarrierResult {
  status: BarrierStatus;
  success: boolean;
}

export async function triggerRelay(
  relayIp: string | null | undefined,
  openSeconds: number
): Promise<BarrierResult> {
  if (!relayIp) {
    return { status: "not_configured", success: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${relayIp}/relay/0?turn=on&timer=${openSeconds}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Rele javobi xato: ${relayIp} (status: ${response.status})`);
      return { status: "failed", success: false };
    }

    console.log(`Rele ochildi: ${relayIp}`);
    return { status: "opened", success: true };
  } catch (err) {
    console.error(`Rele bilan bog'lanib bo'lmadi: ${relayIp}`, err);
    return { status: "failed", success: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function openBarrier(orgId: number, direction: "entry" | "exit"): Promise<BarrierResult> {
  const organization = await db("tb_organizations")
    .leftJoin("tb_settings", "tb_settings.org_id", "tb_organizations.id")
    .select(
      "tb_organizations.relay_entry_ip",
      "tb_organizations.relay_exit_ip",
      "tb_settings.barrier_enabled",
      "tb_settings.barrier_open_seconds"
    )
    .where("tb_organizations.id", orgId)
    .first();

  if (!organization?.barrier_enabled) {
    return { status: "disabled", success: false };
  }

  const relayIp = direction === "entry" ? organization?.relay_entry_ip : organization?.relay_exit_ip;
  const configuredSeconds = Number(organization.barrier_open_seconds);
  const openSeconds =
    Number.isInteger(configuredSeconds) && configuredSeconds > 0 ? configuredSeconds : DEFAULT_OPEN_SECONDS;
  return triggerRelay(relayIp, openSeconds);
}
