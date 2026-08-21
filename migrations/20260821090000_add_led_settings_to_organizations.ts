import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.string("led_host", 255).nullable();
    table.integer("led_port").unsigned().nullable().defaultTo(10000);
  });

  await knex("tb_organizations").whereNot({ id: 1 }).update({ led_host: null, led_port: null });
  await knex("tb_organizations").where({ id: 1 }).update({
    led_host: "192.168.1.157",
    led_port: 10000,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("led_port");
    table.dropColumn("led_host");
  });
}
