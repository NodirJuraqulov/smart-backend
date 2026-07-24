import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_parking_sessions", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.timestamp("entered_at").notNullable();
    table.timestamp("exited_at").nullable();
    table.integer("duration_minutes").unsigned().nullable();
    table.decimal("amount", 10, 2).nullable();
    table.enu("status", ["active", "completed"]).notNullable().defaultTo("active");
    table.enu("entry_method", ["auto", "manual"]).notNullable();
    table.enu("exit_method", ["auto", "manual"]).nullable();
    table.string("image_entry", 500).nullable();
    table.string("image_exit", 500).nullable();
    table
      .integer("operator_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["org_id", "status"]);
    table.index(["org_id", "plate_number"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_parking_sessions");
}
