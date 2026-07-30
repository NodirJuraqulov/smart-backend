import type { Knex } from "knex";

const INDEX_NAME = "idx_webhook_events_recent_direction";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.index(["org_id", "direction", "created_at"], INDEX_NAME);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.dropIndex(["org_id", "direction", "created_at"], INDEX_NAME);
  });
}
