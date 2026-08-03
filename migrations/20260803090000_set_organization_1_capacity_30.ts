import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex("tb_organizations").where({ id: 1, total_capacity: 5000 }).update({ total_capacity: 50 });
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_organizations").where({ id: 1, total_capacity: 50 }).update({ total_capacity: 5000 });
}
