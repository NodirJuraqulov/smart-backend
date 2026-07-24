import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import { db } from "@/config/db";

export async function assertTestDatabase(): Promise<void> {
  const [row] = await db.raw("SELECT DATABASE() as name");
  const name = row[0]?.name;
  if (name !== "stoyanka_test") {
    throw new Error(`Xavfsizlik to'xtatuvi: ulangan baza "${name}", kutilgan "stoyanka_test"`);
  }
}

interface TestOrgOverrides {
  name?: string;
  is_active?: boolean;
  timezone?: string;
}

export async function createTestOrganization(overrides: TestOrgOverrides = {}): Promise<number> {
  const uniqueName = overrides.name ?? `Test Org ${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [id] = await db("tb_organizations").insert({
    name: uniqueName,
    is_active: overrides.is_active ?? true,
    timezone: overrides.timezone ?? "Asia/Tashkent",
  });
  return id;
}

interface TestTariffOverrides {
  name?: string;
  price_per_hour?: number;
  grace_period_minutes?: number;
}

export async function createTestTariff(orgId: number, overrides: TestTariffOverrides = {}): Promise<number> {
  const [id] = await db("tb_tariffs").insert({
    org_id: orgId,
    name: overrides.name ?? "Standart",
    price_per_hour: overrides.price_per_hour ?? 5000,
    grace_period_minutes: overrides.grace_period_minutes ?? 0,
  });
  return id;
}

interface TestSettingsOverrides {
  work_hours_enabled?: boolean;
  work_start?: string;
  work_end?: string;
}

export async function createTestSettings(orgId: number, overrides: TestSettingsOverrides = {}): Promise<void> {
  await db("tb_settings").insert({
    org_id: orgId,
    work_hours_enabled: overrides.work_hours_enabled ?? false,
    work_start: overrides.work_start ?? null,
    work_end: overrides.work_end ?? null,
  });
}

interface TestUserOverrides {
  login?: string;
  password?: string;
  role?: "super_admin" | "operator" | "owner";
  is_active?: boolean;
}

export async function createTestUser(
  orgId: number | null,
  overrides: TestUserOverrides = {}
): Promise<{ id: number; login: string; password: string }> {
  const login = overrides.login ?? `test_user_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const password = overrides.password ?? "correct-password-123";
  const passwordHash = await bcrypt.hash(password, 4);

  const [id] = await db("tb_users").insert({
    org_id: orgId,
    name: "Test User",
    login,
    password: passwordHash,
    role: overrides.role ?? "operator",
    is_active: overrides.is_active ?? true,
  });

  return { id, login, password };
}

export async function setOrgPricingMode(orgId: number, pricingMode: "hourly" | "interval"): Promise<void> {
  await db("tb_organizations").where({ id: orgId }).update({ pricing_mode: pricingMode });
}

export async function setOrgCapacity(orgId: number, totalCapacity: number | null): Promise<void> {
  await db("tb_organizations").where({ id: orgId }).update({ total_capacity: totalCapacity });
}

interface TestTariffIntervalOverrides {
  from_minutes?: number;
  to_minutes?: number | null;
  price?: number;
}

export async function createTestTariffInterval(
  orgId: number,
  overrides: TestTariffIntervalOverrides = {}
): Promise<number> {
  const [id] = await db("tb_tariff_intervals").insert({
    org_id: orgId,
    from_minutes: overrides.from_minutes ?? 5,
    to_minutes: overrides.to_minutes === undefined ? 60 : overrides.to_minutes,
    price: overrides.price ?? 10000,
  });
  return id;
}

export async function createTestVipVehicle(
  orgId: number,
  plateNumber: string,
  note: string | null = null
): Promise<number> {
  const [id] = await db("tb_vip_vehicles").insert({ org_id: orgId, plate_number: plateNumber, note });
  return id;
}

interface TestSubscriptionPlanOverrides {
  name?: string;
  duration_days?: number;
  price?: number;
  is_blocked?: boolean;
}

export async function createTestSubscriptionPlan(
  orgId: number,
  overrides: TestSubscriptionPlanOverrides = {}
): Promise<number> {
  const [id] = await db("tb_subscription_plans").insert({
    org_id: orgId,
    name: overrides.name ?? "Oylik",
    duration_days: overrides.duration_days ?? 30,
    price: overrides.price ?? 100000,
    is_blocked: overrides.is_blocked ?? false,
  });
  return id;
}

interface TestSubscriptionOverrides {
  plan_id?: number | null;
  plan_name_snapshot?: string;
  price_snapshot?: number;
  duration_days_snapshot?: number;
  start_date?: string;
  end_date?: string;
}

export async function createTestSubscription(
  orgId: number,
  plateNumber: string,
  overrides: TestSubscriptionOverrides = {}
): Promise<number> {
  const [id] = await db("tb_subscriptions").insert({
    org_id: orgId,
    plan_id: overrides.plan_id ?? null,
    plate_number: plateNumber,
    plan_name_snapshot: overrides.plan_name_snapshot ?? "Oylik",
    price_snapshot: overrides.price_snapshot ?? 100000,
    duration_days_snapshot: overrides.duration_days_snapshot ?? 30,
    start_date: overrides.start_date ?? DateTime.now().toFormat("yyyy-MM-dd"),
    end_date: overrides.end_date ?? DateTime.now().plus({ days: 30 }).toFormat("yyyy-MM-dd"),
  });
  return id;
}

export async function createTestActiveSession(orgId: number, plateNumber: string): Promise<number> {
  const [id] = await db("tb_parking_sessions").insert({
    org_id: orgId,
    plate_number: plateNumber,
    entered_at: new Date(),
    status: "active",
    entry_method: "manual",
    session_source: "regular",
    active_plate_key: `${orgId}:${plateNumber}`,
  });
  return id;
}

const TEST_SECTION_KEYS = [
  "dashboard",
  "sessions",
  "reports",
  "tariffs",
  "subscriptions",
  "settings",
  "activity_log",
];

export async function seedTestOperatorPermissions(orgId: number): Promise<void> {
  await db("tb_operator_permissions").insert(
    TEST_SECTION_KEYS.map((sectionKey) => ({ org_id: orgId, section_key: sectionKey, can_view: true }))
  );
}

export async function cleanupOrganization(orgId: number): Promise<void> {
  await db("tb_organizations").where({ id: orgId }).del();
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
