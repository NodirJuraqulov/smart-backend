import type { Knex } from "knex";

const DIAGNOSTIC_INDEX = "idx_webhook_events_diagnostics";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.string("plate_number", 20).nullable().alter();
    table.decimal("confidence", 5, 2).nullable();
    table.string("device_id", 100).nullable();
    table.dateTime("camera_event_at").nullable();
    table
      .integer("session_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("SET NULL");
    table.string("processing_result", 50).nullable();
    table.string("processing_reason", 100).nullable();
    table.index(["org_id", "direction", "processing_result", "created_at"], DIAGNOSTIC_INDEX);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.dropIndex(["org_id", "direction", "processing_result", "created_at"], DIAGNOSTIC_INDEX);
    table.dropForeign(["session_id"]);
    table.dropColumns(
      "confidence",
      "device_id",
      "camera_event_at",
      "session_id",
      "processing_result",
      "processing_reason"
    );
    table.string("plate_number", 20).notNullable().alter();
  });
}
