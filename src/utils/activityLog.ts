import { db } from "@/config/db";

export async function logActivity(
  actorId: number | null,
  action: string,
  targetType?: string,
  targetId?: number,
  details?: object
): Promise<void> {
  try {
    await db("tb_activity_logs").insert({
      actor_id: actorId,
      action,
      target_type: targetType ?? null,
      target_id: targetId ?? null,
      details: details !== undefined ? JSON.stringify(details) : null,
    });
  } catch (err) {
    console.error(`Activity log yozib bo'lmadi (action: ${action}):`, err);
  }
}
