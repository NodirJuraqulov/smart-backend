import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    ALTER TABLE tb_parking_sessions
      ADD COLUMN active_plate_key VARCHAR(276) NULL
  `);
  await knex.schema.raw(`
    ALTER TABLE tb_parking_sessions
      ADD UNIQUE KEY uq_parking_active_plate (active_plate_key)
  `);
  await knex.raw(`
    UPDATE tb_parking_sessions
    SET active_plate_key = CONCAT(org_id, ':', plate_number)
    WHERE status = 'active'
  `);

  await knex.schema.raw(`
    ALTER TABLE tb_organizations
      ADD COLUMN dedupe_key VARCHAR(756)
        GENERATED ALWAYS AS (
          CASE WHEN address IS NULL THEN name ELSE CONCAT(name, CHAR(31), address) END
        ) STORED,
      ADD UNIQUE KEY uq_organizations_dedupe (dedupe_key)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    ALTER TABLE tb_organizations
      DROP INDEX uq_organizations_dedupe,
      DROP COLUMN dedupe_key
  `);

  await knex.schema.raw(`
    ALTER TABLE tb_parking_sessions
      DROP INDEX uq_parking_active_plate,
      DROP COLUMN active_plate_key
  `);
}
