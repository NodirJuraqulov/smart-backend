import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.integer("clinic_discount_percent").unsigned().notNullable().defaultTo(20);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("clinic_discount_percent");
  });
}
