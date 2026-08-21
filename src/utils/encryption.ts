import { env } from "@/config/env";
import { decryptWithKey, encryptWithKey } from "@/utils/encryptionCore";

export function encryptSecret(value: string): string {
  return encryptWithKey(value, env.encryptionKey);
}

export function decryptSecret(value: string): string {
  return decryptWithKey(value, env.encryptionKey);
}
