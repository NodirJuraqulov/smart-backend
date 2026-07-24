import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.decimal("tariff_price_per_hour", 10, 2).nullable();
    table.integer("tariff_grace_period_minutes").nullable();
  });

  await knex.schema.alterTable("tb_tariffs", (table) => {
    table.integer("grace_period_minutes").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_tariffs", (table) => {
    table.dropColumn("grace_period_minutes");
  });

  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table.dropColumn("tariff_price_per_hour");
    table.dropColumn("tariff_grace_period_minutes");
  });
}
