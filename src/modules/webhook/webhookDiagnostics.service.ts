import { db } from "@/config/db";

export interface WebhookDiagnosticRange {
  from: Date;
  to: Date;
}

export async function getWebhookEventDiagnostics(orgId: number, range: WebhookDiagnosticRange) {
  const base = () =>
    db("tb_webhook_events")
      .where({ org_id: orgId })
      .whereBetween("created_at", [range.from, range.to]);

  const [confidenceByDirection, outcomeCounts, groupedByHour, groupedByDay] = await Promise.all([
    base()
      .select("direction")
      .count("* as total")
      .count("confidence as with_confidence")
      .avg("confidence as average_confidence")
      .min("confidence as minimum_confidence")
      .max("confidence as maximum_confidence")
      .groupBy("direction"),
    base()
      .select("processing_result")
      .count("* as count")
      .whereNotNull("processing_result")
      .groupBy("processing_result"),
    base()
      .select(db.raw("DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as period"), "direction")
      .count("* as count")
      .groupBy("period", "direction")
      .orderBy("period"),
    base()
      .select(db.raw("DATE_FORMAT(created_at, '%Y-%m-%d') as period"), "direction")
      .count("* as count")
      .groupBy("period", "direction")
      .orderBy("period"),
  ]);

  const [{ null_confidence_count: nullConfidenceCount, malformed_plate_count: malformedPlateCount }] =
    await base().select(
      db.raw("SUM(CASE WHEN confidence IS NULL THEN 1 ELSE 0 END) as null_confidence_count"),
      db.raw(
        "SUM(CASE WHEN plate_number IS NULL OR CHAR_LENGTH(plate_number) < 6 THEN 1 ELSE 0 END) as malformed_plate_count"
      )
    );

  const resultMap = new Map(
    outcomeCounts.map((row) => [String(row.processing_result), Number(row.count)])
  );
  return {
    confidence_by_direction: confidenceByDirection,
    unmatched_exit_count: resultMap.get("unmatched_exit") ?? 0,
    successful_exit_count:
      (resultMap.get("exit_completed") ?? 0) + (resultMap.get("exit_awaiting_payment") ?? 0),
    null_confidence_count: Number(nullConfidenceCount ?? 0),
    malformed_plate_count: Number(malformedPlateCount ?? 0),
    processing_results: outcomeCounts,
    grouped_by_hour: groupedByHour,
    grouped_by_day: groupedByDay,
  };
}
