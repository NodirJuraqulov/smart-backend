import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.index(
      ["org_id", "detected_plate", "status", "resolved_at"],
      "idx_exit_candidates_resolved_cooldown"
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.dropIndex(
      ["org_id", "detected_plate", "status", "resolved_at"],
      "idx_exit_candidates_resolved_cooldown"
    );
  });
}
