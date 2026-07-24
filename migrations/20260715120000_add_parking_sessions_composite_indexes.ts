import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.index(["org_id", "entered_at"]);
    table.index(["org_id", "exited_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.dropIndex(["org_id", "entered_at"]);
    table.dropIndex(["org_id", "exited_at"]);
  });
}
