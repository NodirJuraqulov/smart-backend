import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_cash_collections", (table) => {
    table
      .integer("operator_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.index(["org_id", "operator_id", "period_end"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_cash_collections", (table) => {
    table.dropIndex(["org_id", "operator_id", "period_end"]);
    table.dropForeign(["operator_id"]);
    table.dropColumn("operator_id");
  });
}
