import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.enu("gate_layout", ["shared", "separate"]).notNullable().defaultTo("separate");
    table.integer("cross_camera_guard_seconds").unsigned().notNullable().defaultTo(90);
  });
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.timestamp("processed_at").nullable();
    table.index(
      ["org_id", "plate_number", "direction", "processed_at"],
      "idx_webhook_events_opposite_guard"
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.dropIndex(
      ["org_id", "plate_number", "direction", "processed_at"],
      "idx_webhook_events_opposite_guard"
    );
    table.dropColumn("processed_at");
  });
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("gate_layout");
    table.dropColumn("cross_camera_guard_seconds");
  });
}
