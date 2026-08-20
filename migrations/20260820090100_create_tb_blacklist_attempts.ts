import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_blacklist_attempts", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.timestamp("attempted_at").notNullable();
    table.string("image_url", 500).nullable();
    table.enu("direction", ["entry"]).notNullable().defaultTo("entry");

    table.index(["org_id", "attempted_at"], "idx_blacklist_attempts_org_attempted");
    table.index(["org_id", "plate_number", "attempted_at"], "idx_blacklist_attempts_org_plate_attempted");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_blacklist_attempts");
}
