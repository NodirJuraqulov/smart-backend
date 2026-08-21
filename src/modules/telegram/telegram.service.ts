import { db } from "@/config/db";
import { readWebhookEventImages } from "@/modules/webhook/webhookEventImage.service";
import { decryptSecret } from "@/utils/encryption";

type PaymentMethod = "cash" | "online";

interface TelegramSettingsRow {
  id: number;
  telegram_bot_token: string | null;
  telegram_chat_ids: string | null;
}

interface ExitNotificationParams {
  plateNumber: string;
  amount: number;
  paymentMethod: PaymentMethod;
  imageUrl: string | null;
}

type NotificationPhoto = { buffer: Buffer } | { url: string } | null;

const TELEGRAM_TIMEOUT_MS = 10_000;
const INTERNAL_IMAGE_URL = /^\/api\/webhook-events\/(\d+)\/images\/(?:overview|vehicle|plate)$/;

function parseChatIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (item): item is string => typeof item === "string" && /^-?\d+$/.test(item)
        )
      ),
    ];
  } catch {
    return [];
  }
}

function caption(params: ExitNotificationParams): string {
  const paymentMethod = params.paymentMethod === "online" ? "Online" : "Naqd";
  return `Mashina raqami: ${params.plateNumber}\nSumma: ${params.amount} so'm\nTo'lov turi: ${paymentMethod}`;
}

async function resolvePhoto(orgId: number, imageUrl: string | null): Promise<NotificationPhoto> {
  if (!imageUrl) return null;
  const internalImage = INTERNAL_IMAGE_URL.exec(imageUrl);
  if (internalImage) {
    const eventId = Number(internalImage[1]);
    const images = await readWebhookEventImages(orgId, eventId);
    const buffer = images.overviewImage ?? images.vehicleImage ?? images.plateImage;
    return buffer ? { buffer } : null;
  }
  return /^https?:\/\//i.test(imageUrl) ? { url: imageUrl } : null;
}

async function telegramRequest(
  token: string,
  chatId: string,
  text: string,
  photo: NotificationPhoto
): Promise<void> {
  const method = photo ? "sendPhoto" : "sendMessage";
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let response: Response;
  if (photo && "buffer" in photo) {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", text);
    form.set("photo", new Blob([new Uint8Array(photo.buffer)]), "exit.jpg");
    response = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } else {
    const body = photo
      ? { chat_id: chatId, photo: photo.url, caption: text }
      : { chat_id: chatId, text };
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  }
  if (!response.ok) throw new Error(`Telegram API status ${response.status}`);
}

async function sendToChat(
  token: string,
  chatId: string,
  text: string,
  photo: NotificationPhoto
): Promise<void> {
  try {
    await telegramRequest(token, chatId, text, photo);
  } catch {
    console.error(`TELEGRAM_SEND_FAILED chat_id=${chatId}`);
  }
}

export async function sendExitNotification(
  orgId: number,
  params: ExitNotificationParams
): Promise<void> {
  try {
    const settings = await db<TelegramSettingsRow>("tb_organizations")
      .select("telegram_bot_token", "telegram_chat_ids")
      .where({ id: orgId })
      .first();
    if (!settings?.telegram_bot_token) return;
    const chatIds = parseChatIds(settings.telegram_chat_ids);
    if (chatIds.length === 0) return;
    const token = decryptSecret(settings.telegram_bot_token);
    const text = caption(params);
    const photo = await resolvePhoto(orgId, params.imageUrl).catch(() => null);
    await Promise.allSettled(chatIds.map((chatId) => sendToChat(token, chatId, text, photo)));
  } catch {
    console.error("TELEGRAM_SETTINGS_FAILED");
  }
}

export const telegramService = { sendExitNotification };
