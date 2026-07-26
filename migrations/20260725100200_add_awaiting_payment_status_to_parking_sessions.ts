import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    "ALTER TABLE tb_parking_sessions MODIFY COLUMN status ENUM('active', 'completed', 'awaiting_payment') NOT NULL DEFAULT 'active'"
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    "ALTER TABLE tb_parking_sessions MODIFY COLUMN status ENUM('active', 'completed') NOT NULL DEFAULT 'active'"
  );
}
