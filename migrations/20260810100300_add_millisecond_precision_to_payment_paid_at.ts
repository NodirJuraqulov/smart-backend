import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_payments
      MODIFY COLUMN paid_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_payments
      MODIFY COLUMN paid_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  `);
}
