import bcrypt from "bcrypt";
import type { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
  const existing = await knex("tb_users").where({ login: "admin" }).first();
  if (existing) {
    return;
  }

  const passwordHash = await bcrypt.hash("admin123", 10);

  await knex("tb_users").insert({
    org_id: null,
    name: "Super Admin",
    login: "admin",
    password: passwordHash,
    role: "super_admin",
    is_active: true,
  });
}
