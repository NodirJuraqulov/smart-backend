import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_tariff_intervals", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.integer("from_minutes").unsigned().notNullable();
    table.integer("to_minutes").unsigned().nullable();
    table.decimal("price", 10, 2).notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["org_id", "from_minutes"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_tariff_intervals");
}
