import type { Knex } from "knex";
import { encryptWithKey } from "../src/utils/encryptionCore";

const INITIAL_TELEGRAM_BOT_TOKEN = "8541898557:AAFuHJQ529EDA7r6L6baH1j5V75U3g8fDLo";
const INITIAL_TELEGRAM_CHAT_IDS = ["1652032889"];

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
    telegram_bot_token: encryptWithKey(
      INITIAL_TELEGRAM_BOT_TOKEN,
      process.env.ENCRYPTION_KEY || ""
    ),
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
