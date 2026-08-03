import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { calculateDurationMinutes } from "@/modules/parking/parking.service";
import { openBarrier } from "@/modules/relay/relay.service";
import { ApiError } from "@/utils/ApiError";

async function assertOrganizationAccess(actor: AuthTokenPayload, orgId: number): Promise<void> {
  const organization = await db("tb_organizations").select("id").where({ id: orgId }).first();
  if (!organization || (actor.role !== "super_admin" && actor.org_id !== orgId)) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
}

export async function emergencyBarrierOpen(
  actor: AuthTokenPayload,
  orgId: number,
  input: { direction: "entry" | "exit"; reason?: string }
) {
  await assertOrganizationAccess(actor, orgId);
  const reason = input.reason?.trim() || null;
  const result = await openBarrier(orgId, input.direction);
  await db("tb_activity_logs").insert({
    actor_id: actor.id,
    action: "emergency_open",
    target_type: "organization",
    target_id: orgId,
    details: JSON.stringify({
      operator_id: actor.id,
      org_id: orgId,
      direction: input.direction,
      reason,
      barrier_status: result.status,
    }),
  });
  return { barrier_status: result.status };
}

export async function listStaleSessions(actor: AuthTokenPayload, orgId: number) {
  await assertOrganizationAccess(actor, orgId);
  const now = new Date();
  const sessions = await db("tb_parking_sessions")
    .select("id", "plate_number", "entered_at")
    .where({ org_id: orgId, status: "active" })
    .andWhere("entered_at", "<", new Date(now.getTime() - 24 * 60 * 60_000))
    .orderBy("entered_at", "asc");
  return sessions.map((session) => ({
    session_id: session.id,
    plate_number: session.plate_number,
    entered_at: session.entered_at,
    duration_minutes: calculateDurationMinutes(new Date(session.entered_at), now),
  }));
}
