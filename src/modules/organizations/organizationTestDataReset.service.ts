import { db } from "@/config/db";
import { runBackup } from "@/scripts/backup";
import { ApiError } from "@/utils/ApiError";

export interface TestDataResetCounts {
  sessions: number;
  payments: number;
  paymentTransactions: number;
  entryCandidates: number;
  exitCandidates: number;
  webhookEvents: number;
  webhookDebugLogs: number;
  activityLogs: number;
}

export interface TestDataResetResult {
  success: true;
  backupPath: string;
  deletedCounts: TestDataResetCounts;
}

export async function resetOrganizationTestData(orgId: number, actorId: number): Promise<TestDataResetResult> {
  return db.transaction(async (trx) => {
    const organization = await trx("tb_organizations").select("id").where({ id: orgId }).forUpdate().first();
    if (!organization) throw new ApiError("Stoyanka topilmadi", 404);

    let backupPath: string;
    try {
      backupPath = await runBackup();
    } catch (err) {
      console.error("Majburiy backup yaratilmadi:", err);
      throw new ApiError("Backup yaratilmadi, test ma'lumotlarini tozalash bekor qilindi", 500);
    }

    const userIds = trx("tb_users").select("id").where({ org_id: orgId });
    const sessionIds = trx("tb_parking_sessions").select("id").where({ org_id: orgId });
    const paymentIds = trx("tb_payments").select("id").where({ org_id: orgId });
    const paymentTransactionIds = trx("tb_payment_transactions").select("id").where({ org_id: orgId });
    const entryCandidateIds = trx("tb_entry_candidates").select("id").where({ org_id: orgId });
    const exitCandidateIds = trx("tb_exit_candidates").select("id").where({ org_id: orgId });
    const webhookEventIds = trx("tb_webhook_events").select("id").where({ org_id: orgId });

    const activityLogs = await trx("tb_activity_logs")
      .where((query) => {
        query
          .whereIn("actor_id", userIds)
          .orWhere((target) => {
            target.whereIn("target_type", ["organization", "settings"]).andWhere("target_id", orgId);
          })
          .orWhere((target) => {
            target.where("target_type", "user").whereIn("target_id", userIds);
          })
          .orWhere((target) => {
            target.where("target_type", "session").whereIn("target_id", sessionIds);
          })
          .orWhere((target) => {
            target.where("target_type", "payment").whereIn("target_id", paymentIds);
          })
          .orWhere((target) => {
            target.where("target_type", "payment_transaction").whereIn("target_id", paymentTransactionIds);
          })
          .orWhere((target) => {
            target.where("target_type", "entry_candidate").whereIn("target_id", entryCandidateIds);
          })
          .orWhere((target) => {
            target.where("target_type", "exit_candidate").whereIn("target_id", exitCandidateIds);
          })
          .orWhere((target) => {
            target.where("target_type", "webhook_event").whereIn("target_id", webhookEventIds);
          })
          .orWhereRaw("JSON_UNQUOTE(JSON_EXTRACT(details, '$.orgId')) = ?", [String(orgId)])
          .orWhereRaw("JSON_UNQUOTE(JSON_EXTRACT(details, '$.org_id')) = ?", [String(orgId)]);
      })
      .del();

    const exitCandidates = await trx("tb_exit_candidates").where({ org_id: orgId }).del();
    const entryCandidates = await trx("tb_entry_candidates").where({ org_id: orgId }).del();
    const paymentTransactions = await trx("tb_payment_transactions").where({ org_id: orgId }).del();
    const payments = await trx("tb_payments").where({ org_id: orgId }).del();
    const sessions = await trx("tb_parking_sessions").where({ org_id: orgId }).del();
    const webhookEvents = await trx("tb_webhook_events").where({ org_id: orgId }).del();
    const webhookDebugLogs = (await trx.schema.hasTable("tb_webhook_debug_logs"))
      ? await trx("tb_webhook_debug_logs").where({ org_id: orgId }).del()
      : 0;

    const [{ count: activePlateKeyCount }] = await trx("tb_parking_sessions")
      .where({ org_id: orgId })
      .whereNotNull("active_plate_key")
      .count<{ count: string }[]>("id as count");
    if (Number(activePlateKeyCount) !== 0) {
      throw new ApiError("active_plate_key qoldig'i aniqlandi, tozalash bekor qilindi", 500);
    }

    const deletedCounts: TestDataResetCounts = {
      sessions,
      payments,
      paymentTransactions,
      entryCandidates,
      exitCandidates,
      webhookEvents,
      webhookDebugLogs,
      activityLogs,
    };

    await trx("tb_activity_logs").insert({
      actor_id: actorId,
      action: "organization.test_data_reset",
      target_type: "organization",
      target_id: orgId,
      details: JSON.stringify({ backupPath, deletedCounts }),
    });

    return { success: true, backupPath, deletedCounts };
  });
}
