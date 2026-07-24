import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_users", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("name", 255).notNullable();
    table.string("login", 100).notNullable().unique();
    table.string("password", 255).notNullable();
    table.enu("role", ["super_admin", "operator"]).notNullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_users");
}
