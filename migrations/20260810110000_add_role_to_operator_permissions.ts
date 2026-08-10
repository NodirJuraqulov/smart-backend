import type { Knex } from "knex";

const SECTION_KEYS = [
  "dashboard",
  "sessions",
  "reports",
  "tariffs",
  "subscriptions",
  "settings",
  "activity_log",
];

const KASSIR_DEFAULT_VISIBLE_SECTIONS = ["reports"];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE tb_operator_permissions
      ADD COLUMN role ENUM('operator', 'kassir') NOT NULL DEFAULT 'operator' AFTER org_id
  `);

  await knex.schema.alterTable("tb_operator_permissions", (table) => {
    table.unique(["org_id", "role", "section_key"]);
  });

  await knex.schema.alterTable("tb_operator_permissions", (table) => {
    table.dropUnique(["org_id", "section_key"]);
  });

  const organizations = await knex("tb_organizations").select("id");
  const rows = organizations.flatMap((organization) =>
    SECTION_KEYS.map((sectionKey) => ({
      org_id: organization.id,
      role: "kassir",
      section_key: sectionKey,
      can_view: KASSIR_DEFAULT_VISIBLE_SECTIONS.includes(sectionKey),
    }))
  );

  if (rows.length > 0) {
    await knex("tb_operator_permissions").insert(rows);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_operator_permissions").where({ role: "kassir" }).del();

  await knex.schema.alterTable("tb_operator_permissions", (table) => {
    table.unique(["org_id", "section_key"]);
  });

  await knex.schema.alterTable("tb_operator_permissions", (table) => {
    table.dropUnique(["org_id", "role", "section_key"]);
  });

  await knex.schema.alterTable("tb_operator_permissions", (table) => {
    table.dropColumn("role");
  });
}
