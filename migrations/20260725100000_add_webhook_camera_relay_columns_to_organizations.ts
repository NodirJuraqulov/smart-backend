import { randomBytes } from "crypto";
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.string("webhook_token", 64).nullable().unique();
    table.string("camera_brand", 50).nullable();
    table.string("printer_ip", 45).nullable();
    table.string("relay_entry_ip", 45).nullable();
    table.string("relay_exit_ip", 45).nullable();
    table.timestamp("last_webhook_entry_at").nullable();
    table.timestamp("last_webhook_exit_at").nullable();
  });

  const organizations = await knex("tb_organizations").select("id");
  for (const organization of organizations) {
    await knex("tb_organizations")
      .where({ id: organization.id })
      .update({ webhook_token: randomBytes(32).toString("hex") });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("webhook_token");
    table.dropColumn("camera_brand");
    table.dropColumn("printer_ip");
    table.dropColumn("relay_entry_ip");
    table.dropColumn("relay_exit_ip");
    table.dropColumn("last_webhook_entry_at");
    table.dropColumn("last_webhook_exit_at");
  });
}
