import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.string("entry_camera_relay_host", 255).nullable();
    table.integer("entry_camera_relay_port").unsigned().nullable().defaultTo(80);
    table.string("entry_camera_relay_username", 255).nullable();
    table.string("entry_camera_relay_password_encrypted", 500).nullable();
    table.integer("entry_camera_relay_channel").unsigned().nullable().defaultTo(1);
    table.string("exit_camera_relay_host", 255).nullable();
    table.integer("exit_camera_relay_port").unsigned().nullable().defaultTo(80);
    table.string("exit_camera_relay_username", 255).nullable();
    table.string("exit_camera_relay_password_encrypted", 500).nullable();
    table.integer("exit_camera_relay_channel").unsigned().nullable().defaultTo(1);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("exit_camera_relay_channel");
    table.dropColumn("exit_camera_relay_password_encrypted");
    table.dropColumn("exit_camera_relay_username");
    table.dropColumn("exit_camera_relay_port");
    table.dropColumn("exit_camera_relay_host");
    table.dropColumn("entry_camera_relay_channel");
    table.dropColumn("entry_camera_relay_password_encrypted");
    table.dropColumn("entry_camera_relay_username");
    table.dropColumn("entry_camera_relay_port");
    table.dropColumn("entry_camera_relay_host");
  });
}
