import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_blacklisted_vehicles", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.string("reason", 500).nullable();
    table
      .integer("created_by")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.unique(["org_id", "plate_number"]);
    table.index(["org_id", "created_at"], "idx_blacklisted_vehicles_org_created");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_blacklisted_vehicles");
}
