import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  const orgIds: { org_id: number }[] = await knex("tb_tariffs").distinct("org_id");

  for (const { org_id } of orgIds) {
    const tariffs = await knex("tb_tariffs").where({ org_id }).orderBy("id", "asc");
    if (tariffs.length <= 1) {
      continue;
    }

    const keep = tariffs.find((t) => t.is_active) ?? tariffs[0];
    const removeIds = tariffs.filter((t) => t.id !== keep.id).map((t) => t.id);
    await knex("tb_tariffs").whereIn("id", removeIds).del();
  }
}

export async function down(): Promise<void> {}
