import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_webhook_events", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.enu("direction", ["entry", "exit"]).notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["org_id", "plate_number", "direction", "created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_webhook_events");
}
