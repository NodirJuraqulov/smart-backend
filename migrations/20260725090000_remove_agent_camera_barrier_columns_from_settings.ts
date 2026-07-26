import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("camera_entry_url");
    table.dropColumn("camera_exit_url");
    table.dropColumn("camera_username");
    table.dropColumn("camera_password_encrypted");
    table.dropColumn("barrier_mode");
    table.dropColumn("barrier_entry_port");
    table.dropColumn("barrier_exit_port");
    table.dropColumn("agent_api_key");
    table.dropColumn("last_heartbeat_at");
    table.dropColumn("last_camera_entry_ok");
    table.dropColumn("last_camera_exit_ok");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.string("camera_entry_url", 500).nullable();
    table.string("camera_exit_url", 500).nullable();
    table.string("camera_username", 255).nullable();
    table.string("camera_password_encrypted", 500).nullable();
    table.enu("barrier_mode", ["single", "separate"]).notNullable().defaultTo("single");
    table.string("barrier_entry_port", 50).nullable();
    table.string("barrier_exit_port", 50).nullable();
    table.string("agent_api_key", 255).nullable().unique();
    table.timestamp("last_heartbeat_at").nullable();
    table.boolean("last_camera_entry_ok").nullable();
    table.boolean("last_camera_exit_ok").nullable();
  });
}
