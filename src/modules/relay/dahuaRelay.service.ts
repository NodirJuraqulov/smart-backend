import { createHash, randomBytes } from "crypto";

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

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function parseDigestChallenge(value: string): Record<string, string> | null {
  if (!/^Digest\s/i.test(value)) return null;
  const result: Record<string, string> = {};
  const content = value.replace(/^Digest\s+/i, "");
  const pattern = /([a-z][a-z\d_-]*)=(?:"([^"]*)"|([^,\s]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    result[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return result.realm && result.nonce ? result : null;
}

function digestAuthorization(
  challenge: Record<string, string>,
  username: string,
  password: string,
  method: string,
  uri: string
): string {
  const algorithm = (challenge.algorithm || "MD5").toUpperCase();
  const cnonce = randomBytes(12).toString("hex");
  const nonceCount = "00000001";
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (algorithm === "MD5-SESS") {
    ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  } else if (algorithm !== "MD5") {
    throw new Error(`Qo'llab-quvvatlanmaydigan Digest algoritmi: ${algorithm}`);
  }
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value === "auth");
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const values = [
    `username="${username.replace(/["\\]/g, "")}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (challenge.opaque) values.push(`opaque="${challenge.opaque}"`);
  if (qop) values.push(`qop=${qop}`, `nc=${nonceCount}`, `cnonce="${cnonce}"`);
  return `Digest ${values.join(", ")}`;
}

function normalizeHost(host: string): string {
  const value = host.trim();
  if (!value || /[\s/?#]/.test(value) || value.includes("://")) {
    throw new Error("Relay host formati noto'g'ri");
  }
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

export function buildDahuaRelayUrl(config: Pick<DahuaRelayConfig, "host" | "port" | "channel">): URL {
  if (!config.host) throw new Error("Relay host konfiguratsiya qilinmagan");
  const port = config.port ?? 80;
  const channel = config.channel ?? 1;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(channel) || channel < 1) {
    throw new Error("Kamera relay porti yoki kanali noto'g'ri");
  }
  const host = normalizeHost(config.host);
  const url = new URL(`http://${host}:${port}/cgi-bin/accessControl.cgi`);
  url.searchParams.set("action", "openDoor");
  url.searchParams.set("channel", String(channel));
  url.searchParams.set("UserID", "101");
  url.searchParams.set("Type", "Remote");
  return url;
}

export async function openRelay(config: DahuaRelayConfig): Promise<DahuaRelayResult> {
  if (!config.host || !config.username || !config.password) {
    return { status: "not_configured", detail: "Kamera relay sozlamalari to'liq konfiguratsiya qilinmagan" };
  }
  let url: URL;
  try {
    url = buildDahuaRelayUrl(config);
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : "Relay manzili noto'g'ri" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const method = "GET";
  const uri = `${url.pathname}${url.search}`;
  try {
    const challengeResponse = await fetch(url, { method, signal: controller.signal, redirect: "manual" });
    if (challengeResponse.ok) {
      return { status: "opened", detail: "Dahua relay ochish buyrug'ini qabul qildi" };
    }
    if (challengeResponse.status !== 401) {
      return { status: "failed", detail: `Dahua relay HTTP ${challengeResponse.status} qaytardi` };
    }
    const challenge = parseDigestChallenge(challengeResponse.headers.get("www-authenticate") || "");
    if (!challenge) {
      return { status: "failed", detail: "Dahua relay Digest authentication challenge qaytarmadi" };
    }
    const authorization = digestAuthorization(
      challenge,
      config.username,
      config.password,
      method,
      uri
    );
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "manual",
      headers: { Authorization: authorization },
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "failed", detail: "Dahua relay login yoki parolni qabul qilmadi" };
    }
    if (!response.ok) {
      return { status: "failed", detail: `Dahua relay HTTP ${response.status} qaytardi` };
    }
    return { status: "opened", detail: "Dahua relay ochish buyrug'ini qabul qildi" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "failed", detail: "Dahua relay 5 soniyada javob bermadi" };
    }
    return {
      status: "failed",
      detail: `Dahua relay bilan ulanish xatosi: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
