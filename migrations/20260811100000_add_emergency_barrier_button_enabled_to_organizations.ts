import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.boolean("emergency_barrier_button_enabled").notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("emergency_barrier_button_enabled");
  });
}
