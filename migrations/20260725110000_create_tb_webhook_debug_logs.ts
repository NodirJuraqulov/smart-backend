import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_webhook_debug_logs", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.enu("direction", ["entry", "exit"]).notNullable();
    table.json("headers").nullable();
    table.json("body").nullable();
    table.timestamp("received_at").notNullable().defaultTo(knex.fn.now());

    table.index(["org_id", "received_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_webhook_debug_logs");
}
