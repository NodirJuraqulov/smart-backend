import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.string("overview_image_path", 500).nullable();
    table.string("vehicle_image_path", 500).nullable();
    table.string("plate_image_path", 500).nullable();
    table.string("image_processing_result", 50).nullable();
    table.string("image_processing_reason", 100).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_webhook_events", (table) => {
    table.dropColumns(
      "overview_image_path",
      "vehicle_image_path",
      "plate_image_path",
      "image_processing_result",
      "image_processing_reason"
    );
  });
}
