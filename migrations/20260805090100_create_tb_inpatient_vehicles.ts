import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tb_inpatient_vehicles", (table) => {
    table.increments("id").primary();
    table
      .integer("org_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("tb_organizations")
      .onDelete("CASCADE");
    table.string("plate_number", 20).notNullable();
    table.string("patient_reference", 100).nullable();
    table.string("patient_name", 150).nullable();
    table.date("valid_from").notNullable();
    table.date("valid_until").notNullable();
    table.enu("status", ["active", "expired", "cancelled"]).notNullable().defaultTo("active");
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table
      .integer("cancelled_by")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("tb_users")
      .onDelete("SET NULL");
    table.timestamp("cancelled_at").nullable();

    table.index(["org_id", "plate_number", "status"], "idx_inpatient_vehicles_org_plate_status");
    table.index(["status", "valid_until"], "idx_inpatient_vehicles_status_valid_until");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tb_inpatient_vehicles");
}
