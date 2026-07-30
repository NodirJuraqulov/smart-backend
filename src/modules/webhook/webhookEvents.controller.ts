import { Request, Response } from "express";
import { parseId } from "@/utils/httpParams";
import { getWebhookEventImage, WebhookEventImageKind } from "./webhookEventImage.service";

export async function webhookEventImageHandler(req: Request, res: Response): Promise<void> {
  const eventId = parseId(req, res);
  if (eventId === null) return;
  const kind = req.params.kind as WebhookEventImageKind;
  if (kind !== "overview" && kind !== "vehicle" && kind !== "plate") {
    res.status(404).json({ message: "Rasm turi topilmadi" });
    return;
  }
  const image = await getWebhookEventImage(req.user!, eventId, kind);
  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(image.absolutePath);
}
