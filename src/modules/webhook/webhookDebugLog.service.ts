import { Request } from "express";
import { db } from "@/config/db";

type Direction = "entry" | "exit";

const MAX_STORED_STRING_LENGTH = 500_000;

function truncateString(value: string): string {
  if (value.length <= MAX_STORED_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STORED_STRING_LENGTH)}...[truncated, original ${value.length} chars]`;
}

function decodeBody(req: Request): unknown {
  const body = req.body;

  if (!Buffer.isBuffer(body)) {
    return body ?? null;
  }

  if (body.length === 0) {
    return null;
  }

  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return truncateString(body.toString("utf8"));
    }
  }

  if (contentType.includes("multipart/form-data")) {
    return {
      content_type: contentType,
      encoding: "base64",
      data: truncateString(body.toString("base64")),
    };
  }

  return truncateString(body.toString("utf8"));
}

export async function logWebhookDebug(orgId: number, direction: Direction, req: Request): Promise<void> {
  await db("tb_webhook_debug_logs").insert({
    org_id: orgId,
    direction,
    headers: JSON.stringify(req.headers),
    body: JSON.stringify({ query: req.query, body: decodeBody(req) }),
  });
}
