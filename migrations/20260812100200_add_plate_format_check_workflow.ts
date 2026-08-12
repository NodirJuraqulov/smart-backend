import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_entry_candidates", (table) => {
    table.string("suggested_plate", 20).nullable().after("detected_plate");
  });
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.string("suggested_plate", 20).nullable().after("detected_plate");
  });
  await knex.schema.createTable("tb_plate_format_checks", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.enu("direction", ["entry", "exit"]).notNullable();
    table.string("device_id", 100).notNullable();
    table.string("reference_plate", 20).nullable();
    table.string("last_detected_plate", 20).nullable();
    table
      .integer("last_webhook_event_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_webhook_events")
      .onDelete("CASCADE");
    table.integer("attempts").unsigned().notNullable().defaultTo(1);
    table.enu("status", ["pending", "finalizing"]).notNullable().defaultTo("pending");
    table.dateTime("first_seen_at", { precision: 3 }).notNullable();
    table.dateTime("deadline_at", { precision: 3 }).notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    table.index(
      ["org_id", "direction", "device_id", "status"],
      "idx_plate_format_checks_observation"
    );
    table.index(["status", "deadline_at"], "idx_plate_format_checks_deadline");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_plate_format_checks");
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.dropColumn("suggested_plate");
  });
  await knex.schema.alterTable("tb_entry_candidates", (table) => {
    table.dropColumn("suggested_plate");
  });
}
