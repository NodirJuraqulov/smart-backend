import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_settings", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .unique()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.enu("entry_mode", ["auto", "manual"]).notNullable().defaultTo("auto");
    table.string("camera_url", 500).nullable();
    table.boolean("barrier_enabled").notNullable().defaultTo(false);
    table.string("barrier_port", 50).nullable();
    table.integer("barrier_open_seconds").notNullable().defaultTo(3);
    table.boolean("work_hours_enabled").notNullable().defaultTo(false);
    table.time("work_start").nullable();
    table.time("work_end").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_settings");
}
