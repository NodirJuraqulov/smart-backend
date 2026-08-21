import { createCipheriv, randomBytes } from "crypto";
import type { Knex } from "knex";

const INITIAL_TELEGRAM_BOT_TOKEN = "8541898557:AAFuHJQ529EDA7r6L6baH1j5V75U3g8fDLo";
const INITIAL_TELEGRAM_CHAT_IDS = ["1652032889"];

function encryptInitialToken(value: string): string {
  const rawKey = process.env.ENCRYPTION_KEY?.trim() || "";
  const key = /^[a-f\d]{64}$/i.test(rawKey)
    ? Buffer.from(rawKey, "hex")
    : Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY 32 baytli hex yoki base64 qiymat bo'lishi kerak");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("tb_organizations", "telegram_bot_token"))) {
    await knex.schema.alterTable("tb_organizations", (table) => {
      table.string("telegram_bot_token", 500).nullable();
    });
  }
  if (!(await knex.schema.hasColumn("tb_organizations", "telegram_chat_ids"))) {
    await knex.schema.alterTable("tb_organizations", (table) => {
      table.text("telegram_chat_ids").nullable();
    });
  }

  await knex("tb_organizations").where({ id: 1 }).update({
    telegram_bot_token: encryptInitialToken(INITIAL_TELEGRAM_BOT_TOKEN),
    telegram_chat_ids: JSON.stringify(INITIAL_TELEGRAM_CHAT_IDS),
  });
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("tb_organizations", "telegram_chat_ids")) {
    await knex.schema.alterTable("tb_organizations", (table) => {
      table.dropColumn("telegram_chat_ids");
    });
  }
  if (await knex.schema.hasColumn("tb_organizations", "telegram_bot_token")) {
    await knex.schema.alterTable("tb_organizations", (table) => {
      table.dropColumn("telegram_bot_token");
    });
  }
}
