import type { Knex } from "knex";

const INDEX_NAME = "idx_exit_candidates_org_resolution_resolved";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table
      .specificType(
        "resolution_type",
        "ENUM('exact', 'reassigned', 'dismissed', 'forced_open', 'emergency_forced_open', 'emergency_confirmed')"
      )
      .nullable()
      .alter();
    table.index(["org_id", "resolution_type", "resolved_at"], INDEX_NAME);
  });

  await knex("tb_exit_candidates as candidate")
    .innerJoin("tb_activity_logs as activity", function () {
      this.onVal("activity.target_type", "=", "exit_candidate")
        .andOn("activity.target_id", "=", "candidate.id")
        .andOnVal("activity.action", "=", "exit_candidate.forced_open");
    })
    .where("candidate.resolution_type", "forced_open")
    .whereJsonPath("activity.details", "$.isEmergency", "=", true)
    .update({ "candidate.resolution_type": "emergency_forced_open" });

  await knex("tb_exit_candidates as candidate")
    .innerJoin("tb_parking_sessions as session", function () {
      this.on("session.id", "=", "candidate.resolved_session_id").andOn(
        "session.org_id",
        "=",
        "candidate.org_id"
      );
    })
    .whereIn("candidate.resolution_type", ["exact", "reassigned"])
    .andWhere("session.exit_method", "emergency")
    .update({ "candidate.resolution_type": "emergency_confirmed" });
}

export async function down(knex: Knex): Promise<void> {
  await knex("tb_exit_candidates")
    .where({ resolution_type: "emergency_forced_open" })
    .update({ resolution_type: "forced_open" });
  await knex("tb_exit_candidates")
    .where({ resolution_type: "emergency_confirmed" })
    .update({ resolution_type: "exact" });

  await knex.schema.alterTable("tb_exit_candidates", (table) => {
    table.dropIndex(["org_id", "resolution_type", "resolved_at"], INDEX_NAME);
    table
      .specificType(
        "resolution_type",
        "ENUM('exact', 'reassigned', 'dismissed', 'forced_open')"
      )
      .nullable()
      .alter();
  });
}
