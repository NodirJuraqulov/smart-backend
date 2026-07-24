import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.enu("session_source", ["regular", "subscription", "vip"]).notNullable().defaultTo("regular");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.dropColumn("session_source");
  });
}
