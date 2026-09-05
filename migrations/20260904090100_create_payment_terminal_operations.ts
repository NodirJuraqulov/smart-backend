import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("payment_terminal_operations", (table) => {
    table.increments("id").primary();
    table.integer("org_id").unsigned().notNullable().references("id").inTable("tb_organizations").onDelete("CASCADE");
    table.integer("session_id").unsigned().nullable().references("id").inTable("tb_parking_sessions").onDelete("SET NULL");
    table.integer("candidate_id").unsigned().nullable().references("id").inTable("tb_exit_candidates").onDelete("SET NULL");
    table.integer("operator_id").unsigned().nullable().references("id").inTable("tb_users").onDelete("SET NULL");
    table.string("operation_number", 8).notNullable();
    table.decimal("requested_amount_som", 10, 2).notNullable();
    table.integer("sent_amount_minor").unsigned().notNullable();
    table.decimal("approved_amount_som", 10, 2).nullable();
    table.string("status", 20).notNullable().defaultTo("PENDING");
    table.text("raw_vrp_request_hex").nullable();
    table.text("raw_vrp_response_hex").nullable();
    table.text("raw_fin_request_hex").nullable();
    table.text("raw_fin_response_hex").nullable();
    table.text("error_message").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());

    table.unique(["org_id", "operation_number"]);
    table.index(["org_id", "status"]);
    table.index(["session_id", "created_at"]);
    table.index(["candidate_id"]);
    table.index(["operator_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("payment_terminal_operations");
}
