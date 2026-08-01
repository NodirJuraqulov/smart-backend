import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_payments", (table) => {
    table.specificType("payment_method", "ENUM('cash', 'online')").notNullable().defaultTo("cash").alter();
  });
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table
      .specificType("resolution_type", "ENUM('exact', 'reassigned', 'dismissed', 'forced_open')")
      .nullable()
      .alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  const [{ onlineCount }] = await knex("tb_payments")
    .where({ payment_method: "online" })
    .count<{ onlineCount: string }[]>("id as onlineCount");
  const [{ forcedOpenCount }] = await knex("tb_exit_candidates")
    .where({ resolution_type: "forced_open" })
    .count<{ forcedOpenCount: string }[]>("id as forcedOpenCount");
  if (Number(onlineCount) > 0 || Number(forcedOpenCount) > 0) {
    throw new Error("Rollback uchun online payment va forced_open candidate yozuvlari bo'lmasligi kerak");
  }
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.specificType("resolution_type", "ENUM('exact', 'reassigned', 'dismissed')").nullable().alter();
  });
  await knex.schema.alterTable("tb_payments", (table) => {
    table.specificType("payment_method", "ENUM('cash')").notNullable().defaultTo("cash").alter();
  });
}
