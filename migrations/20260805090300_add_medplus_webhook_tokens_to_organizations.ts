import { randomBytes } from "crypto";
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.string("medplus_discount_webhook_token", 64).nullable().unique();
    table.string("medplus_inpatient_webhook_token", 64).nullable().unique();
  });

  await knex("tb_organizations")
    .where({ id: 1 })
    .update({
      medplus_discount_webhook_token: randomBytes(32).toString("hex"),
      medplus_inpatient_webhook_token: randomBytes(32).toString("hex"),
    });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_organizations", (table) => {
    table.dropColumn("medplus_discount_webhook_token");
    table.dropColumn("medplus_inpatient_webhook_token");
  });
}
