import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";

interface PlanRecord {
  id: number;
  org_id: number;
  name: string;
  duration_days: number;
  price: string;
  is_blocked: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CreatePlanInput {
  name: string;
  duration_days: number;
  price: number;
}

interface UpdatePlanInput {
  name?: string;
  duration_days?: number;
  price?: number;
  is_blocked?: boolean;
}

function requireOrgId(actor: AuthTokenPayload): number {
  if (!actor.org_id) {
    throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
  }
  return actor.org_id;
}

function assertValidDurationDays(durationDays: number) {
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new ApiError("duration_days musbat butun son bo'lishi kerak", 400);
  }
}

async function findPlanOrFail(id: number) {
  const plan = await db<PlanRecord>("tb_subscription_plans").where({ id }).first();
  if (!plan) {
    throw new ApiError("Obuna rejasi topilmadi", 404);
  }
  return plan;
}

function assertInScope(actor: AuthTokenPayload, plan: PlanRecord) {
  if (plan.org_id !== actor.org_id) {
    throw new ApiError("Obuna rejasi topilmadi", 404);
  }
}

export async function listPlans(actor: AuthTokenPayload) {
  const orgId = requireOrgId(actor);
  return db<PlanRecord>("tb_subscription_plans").where({ org_id: orgId }).orderBy("created_at", "desc");
}

export async function createPlan(actor: AuthTokenPayload, input: CreatePlanInput) {
  const orgId = requireOrgId(actor);
  assertValidDurationDays(input.duration_days);

  const [id] = await db("tb_subscription_plans").insert({
    org_id: orgId,
    name: input.name,
    duration_days: input.duration_days,
    price: input.price,
  });

  return db<PlanRecord>("tb_subscription_plans").where({ id }).first();
}

export async function updatePlan(actor: AuthTokenPayload, id: number, input: UpdatePlanInput) {
  const plan = await findPlanOrFail(id);
  assertInScope(actor, plan);

  if (input.duration_days !== undefined) {
    assertValidDurationDays(input.duration_days);
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.duration_days !== undefined) updates.duration_days = input.duration_days;
  if (input.price !== undefined) updates.price = input.price;
  if (input.is_blocked !== undefined) updates.is_blocked = input.is_blocked;

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date();
    await db("tb_subscription_plans").where({ id }).update(updates);
  }

  return db<PlanRecord>("tb_subscription_plans").where({ id }).first();
}

export async function deletePlan(actor: AuthTokenPayload, id: number) {
  const plan = await findPlanOrFail(id);
  assertInScope(actor, plan);
  await db("tb_subscription_plans").where({ id }).del();
}
