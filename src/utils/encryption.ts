import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "@/config/env";

function encryptionKey(): Buffer {
  const raw = env.encryptionKey.trim();
  const key = /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY 32 baytli hex yoki base64 qiymat bo'lishi kerak");
  }
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");
  if (version !== "v1" || !ivValue || !tagValue || encryptedValue === undefined) {
    throw new Error("Shifrlangan qiymat formati noto'g'ri");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64")), decipher.final()]).toString("utf8");
}
