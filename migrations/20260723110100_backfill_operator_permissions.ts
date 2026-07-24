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

export async function up(knex: Knex): Promise<void> {
  const organizations = await knex("tb_organizations").select("id");

  const rows = organizations.flatMap((org) =>
    SECTION_KEYS.map((sectionKey) => ({ org_id: org.id, section_key: sectionKey, can_view: true }))
  );

  if (rows.length > 0) {
    await knex("tb_operator_permissions").insert(rows);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_operator_permissions").del();
}
