import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_users", (table) => {
    table
      .specificType("role", "ENUM('super_admin', 'operator', 'owner', 'kassir', 'registrator')")
      .notNullable()
      .alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  const [{ registratorCount }] = await knex("tb_users")
    .where({ role: "registrator" })
    .count<{ registratorCount: string }[]>("id as registratorCount");
  if (Number(registratorCount) > 0) {
    throw new Error("Rollback uchun registrator foydalanuvchilari bo'lmasligi kerak");
  }
  await knex.schema.alterTable("tb_users", (table) => {
    table
      .specificType("role", "ENUM('super_admin', 'operator', 'owner', 'kassir')")
      .notNullable()
      .alter();
  });
}
