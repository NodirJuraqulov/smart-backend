import { Request } from "express";
import { db } from "@/config/db";

type Direction = "entry" | "exit";

const MAX_SANITIZED_JSON_BYTES = 64 * 1024;

const ALLOWED_HEADER_NAMES = ["content-type", "content-length", "user-agent"];

const SENSITIVE_KEY_PATTERN = /token|key|secret|password|authorization|cookie|signature|credential/i;
const CONTENT_KEY_PATTERN = /^content$/i;
const PICNAME_KEY_PATTERN = /picname$/i;

function sanitizeHeaders(headers: Request["headers"]): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ALLOWED_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === "string") {
      safe[name] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      safe[name] = value.join(", ");
    }
  }
  return safe;
}

function safeBasename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150);
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEY_PATTERN.test(key) && typeof child === "string") {
        result[key] = { redacted: true, originalLength: child.length };
      } else if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = { redacted: true };
      } else if (PICNAME_KEY_PATTERN.test(key) && typeof child === "string") {
        result[key] = safeBasename(child);
      } else {
        result[key] = sanitizeJson(child);
      }
    }
    return result;
  }
  return value;
}

function sanitizeQuery(query: Request["query"]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? { redacted: true } : value;
  }
  return result;
}

function summarizeBody(req: Request): unknown {
  const raw = req.body;
  const contentType = String(req.headers["content-type"] ?? "");

  if (contentType.includes("multipart/form-data")) {
    return { multipart: true, byteLength: Buffer.isBuffer(raw) ? raw.length : 0 };
  }

  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return sanitizeJson(JSON.parse(raw.toString("utf8")));
    } catch (err) {
      return { parseError: { message: err instanceof Error ? err.message : "invalid_json" } };
    }
  }

  return { unsupportedContentType: contentType || null, byteLength: raw.length };
}

export async function logWebhookDebug(orgId: number, direction: Direction, req: Request): Promise<void> {
  const raw = req.body;
  const requestByteLength = Buffer.isBuffer(raw) ? raw.length : 0;
  const body = summarizeBody(req);

  let summary: Record<string, unknown> = {
    direction,
    receivedAt: new Date().toISOString(),
    requestByteLength,
    query: sanitizeQuery(req.query),
    body,
  };

  if (Buffer.byteLength(JSON.stringify(summary), "utf8") > MAX_SANITIZED_JSON_BYTES) {
    summary = {
      direction,
      receivedAt: summary.receivedAt,
      requestByteLength,
      truncated: true,
      topLevelKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [],
    };
  }

  await db("tb_webhook_debug_logs").insert({
    org_id: orgId,
    direction,
    headers: JSON.stringify(sanitizeHeaders(req.headers)),
    body: JSON.stringify(summary),
  });
}
