import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.boolean("last_camera_entry_ok").nullable();
    table.boolean("last_camera_exit_ok").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("last_camera_entry_ok");
    table.dropColumn("last_camera_exit_ok");
  });
}
