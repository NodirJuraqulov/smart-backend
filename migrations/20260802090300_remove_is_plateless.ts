import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn("tb_parking_sessions", "is_plateless")) {
    await knex.schema.alterTable("tb_parking_sessions", (table) => {
      table.dropColumn("is_plateless");
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("tb_parking_sessions", "is_plateless"))) {
    await knex.schema.alterTable("tb_parking_sessions", (table) => {
      table.boolean("is_plateless").notNullable().defaultTo(false).after("plate_number");
    });
  }
}
