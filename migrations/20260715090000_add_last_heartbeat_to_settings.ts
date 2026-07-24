import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.timestamp("last_heartbeat_at").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_settings", (table) => {
    table.dropColumn("last_heartbeat_at");
  });
}
