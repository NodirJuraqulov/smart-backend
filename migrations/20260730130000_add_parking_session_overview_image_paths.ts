import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.string("entry_overview_image_path", 500).nullable();
    table.string("exit_overview_image_path", 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.dropColumn("entry_overview_image_path");
    table.dropColumn("exit_overview_image_path");
  });
}
