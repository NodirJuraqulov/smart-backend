import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table
      .specificType("payment_method", "ENUM('cash', 'online', 'card')")
      .notNullable()
      .defaultTo("cash")
      .alter();
  });
  await knex.schema.alterTable("tb_payments", (table) => {
    table
      .specificType("payment_method", "ENUM('cash', 'online', 'card')")
      .notNullable()
      .defaultTo("cash")
      .alter();
  });
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table
      .specificType(
        "resolution_type",
        "ENUM('exact', 'reassigned', 'dismissed', 'forced_open', 'emergency_forced_open', 'emergency_confirmed', 'card_payment_initiated')"
      )
      .nullable()
      .alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  const cardSession = await knex("tb_parking_sessions").where({ payment_method: "card" }).first();
  const cardPayment = await knex("tb_payments").where({ payment_method: "card" }).first();
  const cardCandidate = await knex("tb_exit_candidates")
    .where({ resolution_type: "card_payment_initiated" })
    .first();
  if (cardSession || cardPayment || cardCandidate) {
    throw new Error("Card ma'lumotlari mavjudligi sababli migration rollback qilinmadi");
  }
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table
      .specificType(
        "resolution_type",
        "ENUM('exact', 'reassigned', 'dismissed', 'forced_open', 'emergency_forced_open', 'emergency_confirmed')"
      )
      .nullable()
      .alter();
  });
  await knex.schema.alterTable("tb_payments", (table) => {
    table
      .specificType("payment_method", "ENUM('cash', 'online')")
      .notNullable()
      .defaultTo("cash")
      .alter();
  });
  await knex.schema.alterTable("tb_parking_sessions", (table) => {
    table
      .specificType("payment_method", "ENUM('cash', 'online')")
      .notNullable()
      .defaultTo("cash")
      .alter();
  });
}
