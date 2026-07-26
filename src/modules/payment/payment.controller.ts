import { Request, Response } from "express";

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
      return body.toString("utf8");
    }
  }

  return body.toString("utf8");
}

export async function paymeWebhookHandler(req: Request, res: Response) {
  console.log("Payme webhook qabul qilindi:", JSON.stringify(decodeBody(req)));
  res.status(200).json({ ok: true });
}

export async function clickWebhookHandler(req: Request, res: Response) {
  console.log("Click webhook qabul qilindi:", JSON.stringify(decodeBody(req)));
  res.status(200).json({ ok: true });
}
