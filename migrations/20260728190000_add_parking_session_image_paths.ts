import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.string("entry_vehicle_image_path", 500).nullable();
    table.string("entry_plate_image_path", 500).nullable();
    table.string("exit_vehicle_image_path", 500).nullable();
    table.string("exit_plate_image_path", 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.dropColumn("entry_vehicle_image_path");
    table.dropColumn("entry_plate_image_path");
    table.dropColumn("exit_vehicle_image_path");
    table.dropColumn("exit_plate_image_path");
  });
}
