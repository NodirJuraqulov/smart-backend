import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_subscriptions", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table
      .integer("plan_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_subscription_plans")
      .onDelete("SET NULL");
    table.string("plate_number", 20).notNullable();
    table.string("plan_name_snapshot", 100).notNullable();
    table.decimal("price_snapshot", 10, 2).notNullable();
    table.integer("duration_days_snapshot").unsigned().notNullable();
    table.date("start_date").notNullable();
    table.date("end_date").notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["org_id", "plate_number"]);
    table.index(["org_id", "end_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_subscriptions");
}
