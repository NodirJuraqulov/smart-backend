import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_activity_logs", (table) => {
    table.dropForeign(["actor_id"]);
  });
  await knex.raw("ALTER TABLE tb_activity_logs MODIFY COLUMN actor_id INT UNSIGNED NULL");
  await knex.schema.alterTable("tb_activity_logs", (table) => {
    table.foreign("actor_id").references("id").inTable("tb_users").onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_activity_logs").whereNull("actor_id").del();
  await knex.schema.alterTable("tb_activity_logs", (table) => {
    table.dropForeign(["actor_id"]);
  });
  await knex.raw("ALTER TABLE tb_activity_logs MODIFY COLUMN actor_id INT UNSIGNED NOT NULL");
  await knex.schema.alterTable("tb_activity_logs", (table) => {
    table.foreign("actor_id").references("id").inTable("tb_users").onDelete("CASCADE");
  });
}
