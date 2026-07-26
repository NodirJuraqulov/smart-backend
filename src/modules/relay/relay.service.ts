import { db } from "@/config/db";

const RELAY_TIMEOUT_MS = 5000;
const DEFAULT_OPEN_SECONDS = 5;

export async function triggerRelay(
  relayIp: string | null | undefined,
  openSeconds: number
): Promise<boolean> {
  if (!relayIp) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${relayIp}/relay/0?turn=on&timer=${openSeconds}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Rele javobi xato: ${relayIp} (status: ${response.status})`);
      return false;
    }

    console.log(`Rele ochildi: ${relayIp}`);
    return true;
  } catch (err) {
    console.error(`Rele bilan bog'lanib bo'lmadi: ${relayIp}`, err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function openBarrier(orgId: number, direction: "entry" | "exit"): Promise<boolean> {
  const organization = await db("tb_organizations")
    .select("relay_entry_ip", "relay_exit_ip")
    .where({ id: orgId })
    .first();

  const relayIp = direction === "entry" ? organization?.relay_entry_ip : organization?.relay_exit_ip;
  return triggerRelay(relayIp, DEFAULT_OPEN_SECONDS);
}
