import { DateTime } from "luxon";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";

interface SubscriptionRecord {
  id: number;
  org_id: number;
  plan_id: number | null;
  plate_number: string;
  plan_name_snapshot: string;
  price_snapshot: string;
  duration_days_snapshot: number;
  start_date: string;
  end_date: string;
  last_renewed_at: string | null;
  created_at: Date;
}

interface SubscriptionWithStatus extends SubscriptionRecord {
  status: "active" | "expired";
}

interface PlanRecord {
  id: number;
  org_id: number;
  name: string;
  duration_days: number;
  price: string;
  is_blocked: boolean;
}

interface CreateSubscriptionInput {
  plate_number: string;
  plan_id: number;
}

interface UpdateSubscriptionInput {
  end_date?: string;
}

interface ListSubscriptionsFilters {
  plan_id?: number;
  status?: "active" | "expired";
  plate_number?: string;
}

function requireOrgId(actor: AuthTokenPayload): number {
  if (!actor.org_id) {
    throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
  }
  return actor.org_id;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

function withStatus(subscription: SubscriptionRecord, today: string): SubscriptionWithStatus {
  return { ...subscription, status: subscription.end_date >= today ? "active" : "expired" };
}

async function getOrgToday(orgId: number): Promise<DateTime> {
  const organization = await db("tb_organizations").select("timezone").where({ id: orgId }).first();
  return DateTime.now().setZone(organization?.timezone);
}

async function findSubscriptionOrFail(id: number) {
  const subscription = await db<SubscriptionRecord>("tb_subscriptions").where({ id }).first();
  if (!subscription) {
    throw new ApiError("Obuna topilmadi", 404);
  }
  return subscription;
}

function assertInScope(actor: AuthTokenPayload, subscription: SubscriptionRecord) {
  if (subscription.org_id !== actor.org_id) {
    throw new ApiError("Obuna topilmadi", 404);
  }
}

export async function listSubscriptions(actor: AuthTokenPayload, filters: ListSubscriptionsFilters) {
  const orgId = requireOrgId(actor);
  const today = (await getOrgToday(orgId)).toFormat("yyyy-MM-dd");

  const query = db<SubscriptionRecord>("tb_subscriptions")
    .where({ org_id: orgId })
    .orderBy("end_date", "desc");

  if (filters.plan_id !== undefined) {
    query.andWhere({ plan_id: filters.plan_id });
  }
  if (filters.plate_number) {
    query.andWhere("plate_number", "like", `%${escapeLikePattern(filters.plate_number)}%`);
  }
  if (filters.status === "active") {
    query.andWhere("end_date", ">=", today);
  } else if (filters.status === "expired") {
    query.andWhere("end_date", "<", today);
  }

  const subscriptions = await query;
  return subscriptions.map((subscription) => withStatus(subscription, today));
}

export async function createSubscription(actor: AuthTokenPayload, input: CreateSubscriptionInput) {
  const orgId = requireOrgId(actor);

  if (!input.plate_number) {
    throw new ApiError("plate_number majburiy", 400);
  }

  const plan = await db<PlanRecord>("tb_subscription_plans")
    .where({ id: input.plan_id, org_id: orgId })
    .first();
  if (!plan) {
    throw new ApiError("Obuna rejasi topilmadi", 404);
  }
  if (plan.is_blocked) {
    throw new ApiError("Bu obuna rejasi bloklangan — yangi obuna yaratib bo'lmaydi", 400);
  }

  const today = await getOrgToday(orgId);
  const startDate = today.toFormat("yyyy-MM-dd");
  const endDate = today.plus({ days: plan.duration_days }).toFormat("yyyy-MM-dd");

  const [id] = await db("tb_subscriptions").insert({
    org_id: orgId,
    plan_id: plan.id,
    plate_number: input.plate_number,
    plan_name_snapshot: plan.name,
    price_snapshot: plan.price,
    duration_days_snapshot: plan.duration_days,
    start_date: startDate,
    end_date: endDate,
  });

  const created = await db<SubscriptionRecord>("tb_subscriptions").where({ id }).first();
  return withStatus(created!, startDate);
}

export async function updateSubscription(actor: AuthTokenPayload, id: number, input: UpdateSubscriptionInput) {
  const subscription = await findSubscriptionOrFail(id);
  assertInScope(actor, subscription);

  if (input.end_date !== undefined) {
    if (!isValidDateString(input.end_date)) {
      throw new ApiError("end_date formati noto'g'ri (YYYY-MM-DD)", 400);
    }
    await db("tb_subscriptions").where({ id }).update({ end_date: input.end_date });
  }

  const today = (await getOrgToday(subscription.org_id)).toFormat("yyyy-MM-dd");
  const updated = await db<SubscriptionRecord>("tb_subscriptions").where({ id }).first();
  return withStatus(updated!, today);
}

export async function renewSubscription(actor: AuthTokenPayload, id: number) {
  const subscription = await findSubscriptionOrFail(id);
  assertInScope(actor, subscription);

  let incrementDays = subscription.duration_days_snapshot;
  if (subscription.plan_id !== null) {
    const plan = await db<PlanRecord>("tb_subscription_plans").where({ id: subscription.plan_id }).first();
    if (plan && !plan.is_blocked) {
      incrementDays = plan.duration_days;
    }
  }

  const today = await getOrgToday(subscription.org_id);
  const todayStr = today.toFormat("yyyy-MM-dd");
  const newEndDate = DateTime.fromISO(subscription.end_date).plus({ days: incrementDays }).toFormat("yyyy-MM-dd");

  await db("tb_subscriptions").where({ id }).update({ end_date: newEndDate, last_renewed_at: todayStr });

  const renewed = await db<SubscriptionRecord>("tb_subscriptions").where({ id }).first();
  return withStatus(renewed!, todayStr);
}

export async function deleteSubscription(actor: AuthTokenPayload, id: number) {
  const subscription = await findSubscriptionOrFail(id);
  assertInScope(actor, subscription);
  await db("tb_subscriptions").where({ id }).del();
}
