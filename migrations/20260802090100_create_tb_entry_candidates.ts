import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_entry_candidates", (table) => {
    table.increments("id").primary();
    table.integer("org_id").unsigned().notNullable().references("id").inTable("tb_organizations").onDelete("CASCADE");
    table
      .integer("webhook_event_id")
      .unsigned()
      .notNullable()
      .unique("uq_entry_candidates_webhook_event")
      .references("id")
      .inTable("tb_webhook_events")
      .onDelete("CASCADE");
    table.string("detected_plate", 20).notNullable();
    table.decimal("confidence", 5, 2).nullable();
    table.dateTime("camera_event_at").notNullable();
    table.enu("status", ["pending", "accepted", "declined", "expired"]).notNullable().defaultTo("pending");
    table.enu("resolution_type", ["accepted", "declined"]).nullable();
    table
      .integer("resolved_session_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("SET NULL");
    table.integer("resolved_by").unsigned().nullable().references("id").inTable("tb_users").onDelete("SET NULL");
    table.dateTime("resolved_at").nullable();
    table.string("note", 500).nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    table.index(["org_id", "status", "created_at"], "idx_entry_candidates_org_status_created");
    table.index(["resolved_session_id", "status"], "idx_entry_candidates_resolved_session");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_entry_candidates");
}
