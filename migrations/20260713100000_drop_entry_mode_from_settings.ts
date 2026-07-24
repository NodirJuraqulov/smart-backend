import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("entry_mode");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.enu("entry_mode", ["auto", "manual"]).notNullable().defaultTo("auto");
  });
}
