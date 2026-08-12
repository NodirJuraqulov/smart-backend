import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_plate_formats", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("pattern", 20).notNullable();
    table.string("description", 255).nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["org_id", "pattern"], { indexName: "uq_plate_formats_org_pattern" });
    table.index(["org_id", "is_active"], "idx_plate_formats_org_active");
  });

  const organization = await knex("tb_organizations").select("id").where({ id: 1 }).first();
  if (organization) {
    await knex("tb_plate_formats").insert([
      {
        org_id: 1,
        pattern: "NNLNNNLL",
        description: "Jismoniy shaxs avtomobili",
      },
      {
        org_id: 1,
        pattern: "NNNNNLLL",
        description: "Yuridik shaxs va davlat tashkiloti avtomobili",
      },
      {
        org_id: 1,
        pattern: "LLLNNN",
        description: "Maxsus davlat seriyasi",
      },
    ]);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_plate_formats");
}
