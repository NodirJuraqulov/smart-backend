import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.string("camera_username", 255).nullable();
    table.string("camera_password_encrypted", 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("camera_username");
    table.dropColumn("camera_password_encrypted");
  });
}
