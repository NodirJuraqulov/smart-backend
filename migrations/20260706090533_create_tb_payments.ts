import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_payments", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table
      .integer("session_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("CASCADE");
    table.decimal("amount", 10, 2).notNullable();
    table.enu("payment_method", ["cash"]).notNullable().defaultTo("cash");
    table.timestamp("paid_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_payments");
}
