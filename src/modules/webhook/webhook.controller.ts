import { Request, Response } from "express";
import { db } from "@/config/db";
import { parseHikvisionPayload } from "./hikvisionParser";
import { logWebhookDebug } from "./webhookDebugLog.service";
import { isDuplicateWebhookEvent } from "./webhookIdempotency";
import { createEntryFromWebhook, createExitFromWebhook } from "@/modules/parking/parking.service";
import { emitWebhookParseFailed } from "@/websocket/socketServer";

async function touchLastWebhookAt(orgId: number, direction: "entry" | "exit"): Promise<void> {
  const column = direction === "entry" ? "last_webhook_entry_at" : "last_webhook_exit_at";
  await db("tb_organizations")
    .where({ id: orgId })
    .update({ [column]: new Date() });
}

export async function debugHandler(req: Request, res: Response) {
  const direction = req.params.direction as "entry" | "exit";
  await logWebhookDebug(req.webhookOrgId!, direction, req);
  res.status(200).json({ ok: true });
}

export async function hikvisionHandler(req: Request, res: Response) {
  const direction = req.params.direction as "entry" | "exit";
  const contentType = (req.headers["content-type"] as string | undefined) ?? "";
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const orgId = req.webhookOrgId!;

  await touchLastWebhookAt(orgId, direction);

  const parsed = parseHikvisionPayload(contentType, rawBody);

  if (!parsed) {
    await logWebhookDebug(orgId, direction, req);
    emitWebhookParseFailed(orgId, {
      direction,
      message: "Kamera signal yubordi, lekin format tanilmadi",
    });
    res.status(200).json({ ok: true, parsed: false });
    return;
  }

  if (await isDuplicateWebhookEvent(orgId, parsed.plateNumber, direction)) {
    console.log(
      `Webhook: takroriy hodisa, e'tiborsiz qoldirildi (org_id: ${orgId}, plate: ${parsed.plateNumber}, ${direction})`
    );
    res.status(200).json({ ok: true, parsed: true, duplicate: true });
    return;
  }

  if (direction === "entry") {
    await createEntryFromWebhook(orgId, parsed.plateNumber, parsed.confidence);
  } else {
    await createExitFromWebhook(orgId, parsed.plateNumber, parsed.confidence);
  }

  res.status(200).json({
    ok: true,
    parsed: true,
    plate_number: parsed.plateNumber,
    confidence: parsed.confidence,
    timestamp: parsed.timestamp,
  });
}
