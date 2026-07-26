import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_payment_transactions", (table) => {
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
      .nullable()
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("SET NULL");
    table.enu("provider", ["payme", "click"]).notNullable();
    table.string("provider_transaction_id", 255).notNullable();
    table.decimal("amount", 12, 2).notNullable();
    table.enu("state", ["created", "performed", "cancelled"]).notNullable().defaultTo("created");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("performed_at").nullable();
    table.timestamp("cancelled_at").nullable();

    table.unique(["provider", "provider_transaction_id"]);
    table.index(["org_id"]);
    table.index(["session_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_payment_transactions");
}
