import type { Knex } from "knex";

const RESOLUTION_TYPES =
  "ENUM('exact', 'reassigned', 'dismissed', 'forced_open', 'emergency_forced_open', 'emergency_confirmed', 'card_payment_initiated', 'exit_cancelled')";

const PREVIOUS_RESOLUTION_TYPES =
  "ENUM('exact', 'reassigned', 'dismissed', 'forced_open', 'emergency_forced_open', 'emergency_confirmed', 'card_payment_initiated')";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.specificType("resolution_type", RESOLUTION_TYPES).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  const candidate = await knex("tb_exit_candidates").where({ resolution_type: "exit_cancelled" }).first();
  if (candidate) throw new Error("exit_cancelled yozuvlari mavjudligi sababli migration rollback qilinmadi");
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.specificType("resolution_type", PREVIOUS_RESOLUTION_TYPES).nullable().alter();
  });
}
