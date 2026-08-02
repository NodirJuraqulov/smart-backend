import type { Knex } from "knex";

const ENTRY_REASONS = [
  "capacity_full",
  "plate_not_detected",
  "capacity_full_and_plate_not_detected",
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.string("plate_number", 20).nullable().alter();
  });

  await knex.schema.alterTable("tb_entry_candidates", (table) => {
    table.string("detected_plate", 20).nullable().alter();
    table.enu("reason", ENTRY_REASONS).nullable().after("detected_plate");
  });

  await knex("tb_entry_candidates").update({ reason: "capacity_full" });

  await knex.schema.alterTable("tb_entry_candidates", (table) => {
    table.enu("reason", ENTRY_REASONS).notNullable().alter();
    table.index(["org_id", "status", "detected_plate"], "idx_entry_candidates_org_status_plate");
    table.index(
      ["org_id", "status", "reason", "camera_event_at"],
      "idx_entry_candidates_org_status_reason_event"
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  const nullableSessions = await knex("tb_parking_sessions").whereNull("plate_number").first();
  if (nullableSessions) {
    throw new Error("NULL plate_number mavjudligi sababli migration rollback qilinmadi");
  }
  const nullableCandidates = await knex("tb_entry_candidates").whereNull("detected_plate").first();
  if (nullableCandidates) {
    throw new Error("NULL detected_plate mavjudligi sababli migration rollback qilinmadi");
  }

  await knex.schema.alterTable("tb_entry_candidates", (table) => {
    table.dropIndex(["org_id", "status", "detected_plate"], "idx_entry_candidates_org_status_plate");
    table.dropIndex(
      ["org_id", "status", "reason", "camera_event_at"],
      "idx_entry_candidates_org_status_reason_event"
    );
    table.dropColumn("reason");
    table.string("detected_plate", 20).notNullable().alter();
  });

  if (await knex.schema.hasColumn("tb_parking_sessions", "is_plateless")) {
    await knex.schema.alterTable("tb_parking_sessions", (table) => {
      table.dropColumn("is_plateless");
    });
  }

  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.string("plate_number", 20).notNullable().alter();
  });
}
