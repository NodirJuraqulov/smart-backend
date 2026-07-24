import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_users
      MODIFY COLUMN role ENUM('super_admin', 'operator', 'owner') NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_users
      MODIFY COLUMN role ENUM('super_admin', 'operator') NOT NULL
  `);
}
