import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.enu("barrier_mode", ["single", "separate"]).notNullable().defaultTo("single");
    table.string("barrier_entry_port", 50).nullable();
    table.string("barrier_exit_port", 50).nullable();
  });

  await knex("tb_settings").update({
    barrier_entry_port: knex.raw("barrier_port"),
    barrier_exit_port: knex.raw("barrier_port"),
    barrier_mode: "single",
  });

  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("barrier_port");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.string("barrier_port", 50).nullable();
  });

  await knex("tb_settings").update({
    barrier_port: knex.raw("barrier_entry_port"),
  });

  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("barrier_mode");
    table.dropColumn("barrier_entry_port");
    table.dropColumn("barrier_exit_port");
  });
}
