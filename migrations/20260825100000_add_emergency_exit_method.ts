import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table
      .specificType(
        "exit_method",
        "ENUM('auto', 'manual', 'forced', 'auto_closed_on_reentry', 'emergency')"
      )
      .nullable()
      .alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_parking_sessions").where({ exit_method: "emergency" }).update({ exit_method: "forced" });
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table
      .specificType("exit_method", "ENUM('auto', 'manual', 'forced', 'auto_closed_on_reentry')")
      .nullable()
      .alter();
  });
}
