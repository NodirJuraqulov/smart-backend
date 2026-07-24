import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_activity_logs", (table) => {
    table.increments("id").primary();
    table
      .integer("actor_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("CASCADE");
    table.string("action", 100).notNullable();
    table.string("target_type", 50).nullable();
    table.integer("target_id").unsigned().nullable();
    table.json("details").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["action"]);
    table.index(["target_type", "target_id"]);
    table.index(["created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_activity_logs");
}
