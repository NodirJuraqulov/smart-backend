import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_clinic_discounts", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.integer("discount_percent").unsigned().notNullable();
    table.enu("status", ["pending", "used", "expired", "cancelled"]).notNullable().defaultTo("pending");
    table.string("source_reference", 100).nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("used_at").nullable();
    table
      .integer("used_session_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_parking_sessions")
      .onDelete("SET NULL");
    table
      .integer("cancelled_by")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.timestamp("cancelled_at").nullable();

    table.index(["org_id", "plate_number", "status", "created_at"], "idx_clinic_discounts_org_plate_status");
    table.index(["status", "created_at"], "idx_clinic_discounts_status_created");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_clinic_discounts");
}
