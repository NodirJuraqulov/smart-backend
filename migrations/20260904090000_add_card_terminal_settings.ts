import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.boolean("card_terminal_enabled").notNullable().defaultTo(false);
    table.string("card_terminal_ip", 45).nullable();
    table.integer("card_terminal_port").unsigned().nullable().defaultTo(62801);
    table.string("card_terminal_id", 64).nullable();
    table.string("card_terminal_merchant_id", 64).nullable();
    table.integer("card_terminal_keepalive_interval_seconds").unsigned().nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("card_terminal_keepalive_interval_seconds");
    table.dropColumn("card_terminal_merchant_id");
    table.dropColumn("card_terminal_id");
    table.dropColumn("card_terminal_port");
    table.dropColumn("card_terminal_ip");
    table.dropColumn("card_terminal_enabled");
  });
}
