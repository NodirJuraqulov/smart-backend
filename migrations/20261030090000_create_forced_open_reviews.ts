import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("forced_open_reviews", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.integer("candidate_id").notNullable();
    table
      .integer("operator_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.string("operator_name", 255).notNullable();
    table.timestamp("forced_at").notNullable();
    table.string("detected_plate", 20).nullable();
    table.integer("webhook_event_id").nullable();
    table.integer("session_id").unsigned().nullable();
    table.string("session_plate", 20).nullable();
    table.timestamp("entered_at").nullable();
    table.integer("duration_minutes").unsigned().nullable();
    table.decimal("amount_som", 10, 2).notNullable();
    table.string("kind", 20).notNullable();
    table
      .integer("saved_by")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.unique(["org_id", "candidate_id"]);
    table.index(["org_id", "operator_id", "forced_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("forced_open_reviews");
}
