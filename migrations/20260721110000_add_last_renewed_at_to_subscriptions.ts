import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_subscriptions", (table) => {
    table.date("last_renewed_at").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_subscriptions", (table) => {
    table.dropColumn("last_renewed_at");
  });
}
