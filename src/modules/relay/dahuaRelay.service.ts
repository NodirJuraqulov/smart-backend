import { createHash } from "crypto";

const REQUEST_TIMEOUT_MS = 5000;

export interface DahuaRelayConfig {
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  channel?: number | null;
}

export interface DahuaRelayResult {
  status: "opened" | "failed" | "not_configured";
  detail: string;
}

interface DahuaRpcResponse {
  result?: boolean;
  session?: string | number;
  params?: {
    random?: string;
    realm?: string;
    encryption?: string;
  };
  error?: unknown;
}

function md5Upper(value: string): string {
  return createHash("md5").update(value).digest("hex").toUpperCase();
}

export function calculateDahuaLoginHash(
  username: string,
  realm: string,
  password: string,
  random: string
): string {
  const passwordHash = md5Upper(`${username}:${realm}:${password}`);
  return md5Upper(`${username}:${random}:${passwordHash}`);
}

function normalizeHost(host: string): string {
  const value = host.trim();
  if (!value || /[\s/?#]/.test(value) || value.includes("://")) {
    throw new Error("Relay host formati noto'g'ri");
  }
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function buildRpcUrl(
  config: Pick<DahuaRelayConfig, "host" | "port">,
  endpoint: "RPC2_Login" | "RPC2"
): URL {
  if (!config.host) throw new Error("Relay host konfiguratsiya qilinmagan");
  const port = config.port ?? 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Kamera relay porti noto'g'ri");
  }
  return new URL(`http://${normalizeHost(config.host)}:${port}/${endpoint}`);
}

function sessionValue(value: string | number | undefined): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

async function postRpc(url: URL, body: Record<string, unknown>): Promise<DahuaRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("RPC2 javobi noto'g'ri");
    }
    return payload as DahuaRpcResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export async function openRelay(config: DahuaRelayConfig): Promise<DahuaRelayResult> {
  if (!config.host || !config.username || !config.password) {
    return { status: "not_configured", detail: "Kamera relay sozlamalari to'liq konfiguratsiya qilinmagan" };
  }

  let loginUrl: URL;
  let commandUrl: URL;
  try {
    loginUrl = buildRpcUrl(config, "RPC2_Login");
    commandUrl = buildRpcUrl(config, "RPC2");
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : "Relay manzili noto'g'ri" };
  }

  let challenge: DahuaRpcResponse;
  try {
    challenge = await postRpc(loginUrl, {
      method: "global.login",
      params: {
        userName: config.username,
        password: "",
        clientType: "Web3.0",
      },
      id: 1,
    });
  } catch {
    return { status: "failed", detail: "Kameraga ulanib bo'lmadi" };
  }

  const temporarySession = sessionValue(challenge.session);
  const random = challenge.params?.random;
  const realm = challenge.params?.realm;
  if (!temporarySession || !random || !realm) {
    return { status: "failed", detail: "Kameraga ulanib bo'lmadi" };
  }

  const passwordHash = calculateDahuaLoginHash(config.username, realm, config.password, random);
  let login: DahuaRpcResponse;
  try {
    login = await postRpc(loginUrl, {
      method: "global.login",
      params: {
        userName: config.username,
        password: passwordHash,
        clientType: "Web3.0",
        authorityType: "Default",
      },
      id: 2,
      session: temporarySession,
    });
  } catch {
    return { status: "failed", detail: "Kameraga ulanib bo'lmadi" };
  }

  const authenticatedSession = sessionValue(login.session);
  if (login.result !== true || !authenticatedSession) {
    return { status: "failed", detail: "Kamera autentifikatsiyasi muvaffaqiyatsiz (login/parol xato)" };
  }

  let openResult: DahuaRpcResponse;
  try {
    openResult = await postRpc(commandUrl, {
      method: "trafficSnap.openStrobe",
      params: {
        info: {
          openType: "Test",
          plateNumber: "",
        },
      },
      id: 3,
      session: authenticatedSession,
    });
  } catch {
    return { status: "failed", detail: "Shlagbaum ochish buyrug'i yuborilmadi" };
  }

  if (openResult.result !== true || openResult.error) {
    return { status: "failed", detail: "Kamera shlagbaumni ochishni rad etdi" };
  }
  return { status: "opened", detail: "Kamera shlagbaumni ochdi" };
}
