import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.string("camera_entry_url", 500).nullable();
    table.string("camera_exit_url", 500).nullable();
  });

  await knex("tb_settings").whereNotNull("camera_url").update({
    camera_entry_url: knex.raw("camera_url"),
    camera_exit_url: knex.raw("camera_url"),
  });

  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("camera_url");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.string("camera_url", 500).nullable();
  });

  await knex("tb_settings").whereNotNull("camera_entry_url").update({
    camera_url: knex.raw("camera_entry_url"),
  });

  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("camera_entry_url");
    table.dropColumn("camera_exit_url");
  });
}
