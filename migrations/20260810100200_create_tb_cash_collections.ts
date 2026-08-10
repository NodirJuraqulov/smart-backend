import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_cash_collections", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table
      .integer("collected_by")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.decimal("expected_amount", 12, 2).notNullable().defaultTo(0);
    table.decimal("collected_amount", 12, 2).notNullable();
    table.decimal("online_amount_snapshot", 12, 2).notNullable().defaultTo(0);
    table.string("note", 500).nullable();
    table.timestamp("period_start", { precision: 3 }).notNullable();
    table.timestamp("period_end", { precision: 3 }).notNullable();
    table.timestamp("created_at", { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.index(["org_id", "period_end"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_cash_collections");
}
