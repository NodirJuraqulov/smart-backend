import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_parking_sessions
      MODIFY COLUMN exit_method ENUM('auto', 'manual', 'forced', 'auto_closed_on_reentry') NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_parking_sessions
      MODIFY COLUMN exit_method ENUM('auto', 'manual', 'forced') NULL
  `);
}
