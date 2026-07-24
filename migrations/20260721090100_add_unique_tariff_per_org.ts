import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_tariffs", (table) => {
    table.unique(["org_id"], { indexName: "uq_tariffs_org_id" });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_tariffs", (table) => {
    table.dropUnique(["org_id"], "uq_tariffs_org_id");
  });
}
