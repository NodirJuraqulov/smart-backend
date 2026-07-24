import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { seedDefaultPermissions } from "@/modules/operatorPermissions/operatorPermissions.service";
import { ApiError } from "@/utils/ApiError";
import { isDuplicateKeyError } from "@/utils/dbErrors";

interface OrganizationRecord {
  id: number;
  name: string;
  address: string | null;
  is_active: boolean;
  timezone: string;
  pricing_mode: "hourly" | "interval";
  total_capacity: number | null;
  created_at: Date;
}

function organizationsBaseQuery() {
  return db<OrganizationRecord>("tb_organizations").select(
    "id",
    "name",
    "address",
    "is_active",
    "timezone",
    "pricing_mode",
    "total_capacity",
    "created_at"
  );
}

const HEARTBEAT_ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function computeIsOnline(lastHeartbeatAt: Date | null): boolean {
  if (!lastHeartbeatAt) return false;
  return Date.now() - new Date(lastHeartbeatAt).getTime() < HEARTBEAT_ONLINE_THRESHOLD_MS;
}

function assertValidTimezone(timezone: string) {
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new ApiError(`Noto'g'ri timezone: "${timezone}" (IANA formatida bo'lishi kerak, masalan "Asia/Tashkent")`, 400);
  }
}

interface CreateOrganizationInput {
  name: string;
  address?: string | null;
  timezone?: string;
  owner: {
    name: string;
    login: string;
    password: string;
  };
  operator?: {
    name: string;
    login: string;
    password: string;
  };
  tariff: {
    price_per_hour: number;
    grace_period_minutes?: number;
  };
}

interface AddOperatorInput {
  name: string;
  login: string;
  password: string;
}

interface UpdateOrganizationInput {
  name?: string;
  address?: string | null;
  timezone?: string;
}

export async function listOrganizations() {
  const rows = await db<OrganizationRecord & { last_heartbeat_at: Date | null }>("tb_organizations")
    .leftJoin("tb_settings", "tb_settings.org_id", "tb_organizations.id")
    .select(
      "tb_organizations.id",
      "tb_organizations.name",
      "tb_organizations.address",
      "tb_organizations.is_active",
      "tb_organizations.timezone",
      "tb_organizations.pricing_mode",
      "tb_organizations.total_capacity",
      "tb_organizations.created_at",
      "tb_settings.last_heartbeat_at"
    )
    .orderBy("tb_organizations.created_at", "desc");

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    is_active: row.is_active,
    timezone: row.timezone,
    pricing_mode: row.pricing_mode,
    total_capacity: row.total_capacity,
    created_at: row.created_at,
    is_online: computeIsOnline(row.last_heartbeat_at),
  }));
}

async function findOrganizationOrFail(id: number) {
  const organization = await organizationsBaseQuery().where({ id }).first();
  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
  return organization;
}

async function assertNoDuplicateOrganization(
  name: string,
  address: string | null | undefined,
  excludeId?: number
) {
  const query = db("tb_organizations").where({ name });
  if (address !== null && address !== undefined) {
    query.andWhere({ address });
  }
  if (excludeId !== undefined) {
    query.andWhereNot({ id: excludeId });
  }
  const existing = await query.first();
  if (existing) {
    throw new ApiError("Bu manzilda bunday stoyanka allaqachon mavjud!", 409);
  }
}

export async function createOrganization(input: CreateOrganizationInput) {
  const { name, address, owner, operator, tariff } = input;

  if (input.timezone !== undefined) {
    assertValidTimezone(input.timezone);
  }

  await assertNoDuplicateOrganization(name, address);

  const existingOwnerLogin = await db("tb_users").where({ login: owner.login }).first();
  if (existingOwnerLogin) {
    throw new ApiError("Bu login allaqachon band", 409);
  }
  if (operator) {
    const existingOperatorLogin = await db("tb_users").where({ login: operator.login }).first();
    if (existingOperatorLogin) {
      throw new ApiError("Bu login allaqachon band", 409);
    }
  }

  try {
    return await db.transaction(async (trx) => {
      const [orgId] = await trx("tb_organizations").insert({
        name,
        address: address ?? null,
        // Column default ('Asia/Tashkent') applies when omitted.
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      });

      const ownerPasswordHash = await bcrypt.hash(owner.password, 10);
      const [ownerId] = await trx("tb_users").insert({
        org_id: orgId,
        name: owner.name,
        login: owner.login,
        password: ownerPasswordHash,
        role: "owner",
        is_active: true,
      });

      let operatorId: number | null = null;
      if (operator) {
        const operatorPasswordHash = await bcrypt.hash(operator.password, 10);
        [operatorId] = await trx("tb_users").insert({
          org_id: orgId,
          name: operator.name,
          login: operator.login,
          password: operatorPasswordHash,
          role: "operator",
          is_active: true,
        });
      }

      await trx("tb_settings").insert({
        org_id: orgId,
        barrier_enabled: false,
        barrier_open_seconds: 3,
        work_hours_enabled: false,
      });

      await seedDefaultPermissions(trx, orgId);

      await trx("tb_tariffs").insert({
        org_id: orgId,
        name: "Standart",
        price_per_hour: tariff.price_per_hour,
        grace_period_minutes: tariff.grace_period_minutes ?? 0,
      });

      const organization = await trx<OrganizationRecord>("tb_organizations")
        .select("id", "name", "address", "is_active", "timezone", "pricing_mode", "total_capacity", "created_at")
        .where({ id: orgId })
        .first();
      const createdOwner = await trx("tb_users")
        .select("id", "org_id", "name", "login", "role", "is_active")
        .where({ id: ownerId })
        .first();
      const createdOperator = operatorId
        ? await trx("tb_users")
            .select("id", "org_id", "name", "login", "role", "is_active")
            .where({ id: operatorId })
            .first()
        : null;
      const createdTariff = await trx("tb_tariffs").where({ org_id: orgId }).first();

      return { organization, owner: createdOwner, operator: createdOperator, tariff: createdTariff };
    });
  } catch (err) {
    if (isDuplicateKeyError(err, "tb_users_login_unique")) {
      throw new ApiError("Bu login allaqachon band", 409);
    }
    if (isDuplicateKeyError(err, "uq_organizations_dedupe")) {
      throw new ApiError("Bu manzilda bunday stoyanka allaqachon mavjud!", 409);
    }
    throw err;
  }
}

export async function addOperator(orgId: number, input: AddOperatorInput) {
  await findOrganizationOrFail(orgId);

  const existingOperator = await db("tb_users").where({ org_id: orgId, role: "operator" }).first();
  if (existingOperator) {
    throw new ApiError("Bu stoyankada operator allaqachon mavjud", 400);
  }

  const existingLogin = await db("tb_users").where({ login: input.login }).first();
  if (existingLogin) {
    throw new ApiError("Bu login allaqachon band", 409);
  }

  const passwordHash = await bcrypt.hash(input.password, 10);

  try {
    const [operatorId] = await db("tb_users").insert({
      org_id: orgId,
      name: input.name,
      login: input.login,
      password: passwordHash,
      role: "operator",
      is_active: true,
    });

    return db("tb_users")
      .select("id", "org_id", "name", "login", "role", "is_active")
      .where({ id: operatorId })
      .first();
  } catch (err) {
    if (isDuplicateKeyError(err, "tb_users_login_unique")) {
      throw new ApiError("Bu login allaqachon band", 409);
    }
    throw err;
  }
}

export async function updateOrganization(id: number, input: UpdateOrganizationInput) {
  const organization = await findOrganizationOrFail(id);

  if (input.timezone !== undefined) {
    assertValidTimezone(input.timezone);
  }

  const effectiveName = input.name !== undefined ? input.name : organization.name;
  const effectiveAddress = input.address !== undefined ? input.address : organization.address;
  await assertNoDuplicateOrganization(effectiveName, effectiveAddress, id);

  const updates: UpdateOrganizationInput = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.address !== undefined) updates.address = input.address;
  if (input.timezone !== undefined) updates.timezone = input.timezone;

  if (Object.keys(updates).length > 0) {
    try {
      await db("tb_organizations").where({ id }).update(updates);
    } catch (err) {
      if (isDuplicateKeyError(err, "uq_organizations_dedupe")) {
        throw new ApiError("Bu manzilda bunday stoyanka allaqachon mavjud!", 409);
      }
      throw err;
    }
  }

  return { ...organization, ...updates };
}

export async function updatePricingMode(id: number, pricingMode: "hourly" | "interval") {
  const organization = await findOrganizationOrFail(id);
  await db("tb_organizations").where({ id }).update({ pricing_mode: pricingMode });
  return { ...organization, pricing_mode: pricingMode };
}

export async function updateCapacity(id: number, totalCapacity: number | null) {
  const organization = await findOrganizationOrFail(id);
  await db("tb_organizations").where({ id }).update({ total_capacity: totalCapacity });
  return { ...organization, total_capacity: totalCapacity };
}

export async function toggleBlockOrganization(id: number, isActive?: boolean) {
  const organization = await findOrganizationOrFail(id);

  const nextValue = isActive !== undefined ? isActive : !organization.is_active;
  await db("tb_organizations").where({ id }).update({ is_active: nextValue });

  return { ...organization, is_active: nextValue };
}

export async function getOrganizationStats(id: number) {
  const organization = await findOrganizationOrFail(id);

  const now = DateTime.now().setZone(organization.timezone);
  const todayStart = now.startOf("day").toJSDate();
  const todayEnd = now.endOf("day").toJSDate();

  const [
    [todayEntries],
    [todayExits],
    [todayRevenue],
    [currentlyParked],
    [totalSessions],
    [totalRevenue],
    settings,
  ] = await Promise.all([
    db("tb_parking_sessions")
      .where({ org_id: id })
      .whereBetween("entered_at", [todayStart, todayEnd])
      .count<{ count: string }[]>("id as count"),
    db("tb_parking_sessions")
      .where({ org_id: id })
      .whereBetween("exited_at", [todayStart, todayEnd])
      .count<{ count: string }[]>("id as count"),
    db("tb_payments")
      .where({ org_id: id })
      .whereBetween("paid_at", [todayStart, todayEnd])
      .sum<{ total: string | null }[]>("amount as total"),
    db("tb_parking_sessions")
      .where({ org_id: id, status: "active" })
      .count<{ count: string }[]>("id as count"),
    db("tb_parking_sessions").where({ org_id: id }).count<{ count: string }[]>("id as count"),
    db("tb_payments").where({ org_id: id }).sum<{ total: string | null }[]>("amount as total"),
    db("tb_settings").select("last_heartbeat_at").where({ org_id: id }).first(),
  ]);

  const lastHeartbeatAt = settings?.last_heartbeat_at ?? null;

  return {
    organization_id: id,
    today_entries: Number(todayEntries.count),
    today_exits: Number(todayExits.count),
    today_revenue: Number(todayRevenue.total ?? 0),
    currently_parked: Number(currentlyParked.count),
    total_sessions: Number(totalSessions.count),
    total_revenue: Number(totalRevenue.total ?? 0),
    is_online: computeIsOnline(lastHeartbeatAt),
    last_heartbeat_at: lastHeartbeatAt,
  };
}

export async function getGlobalStats() {
  const now = DateTime.now().setZone(env.platformDefaultTimezone);
  const todayStart = now.startOf("day").toJSDate();
  const todayEnd = now.endOf("day").toJSDate();
  const monthStart = now.startOf("month").toJSDate();
  const monthEnd = now.endOf("month").toJSDate();

  const [
    [{ count: totalOrganizations }],
    [{ count: activeOrganizations }],
    [{ total: totalRevenueToday }],
    [{ total: totalRevenueMonthly }],
    [{ count: totalCurrentlyParked }],
    organizations,
    revenueByOrgRows,
    parkedByOrgRows,
  ] = await Promise.all([
    db("tb_organizations").count<{ count: string }[]>("id as count"),
    db("tb_organizations").where({ is_active: true }).count<{ count: string }[]>("id as count"),
    db("tb_payments")
      .whereBetween("paid_at", [todayStart, todayEnd])
      .sum<{ total: string | null }[]>("amount as total"),
    db("tb_payments")
      .whereBetween("paid_at", [monthStart, monthEnd])
      .sum<{ total: string | null }[]>("amount as total"),
    db("tb_parking_sessions").where({ status: "active" }).count<{ count: string }[]>("id as count"),
    db("tb_organizations")
      .leftJoin("tb_settings", "tb_settings.org_id", "tb_organizations.id")
      .select("tb_organizations.id", "tb_organizations.name", "tb_settings.last_heartbeat_at"),
    db("tb_payments")
      .whereBetween("paid_at", [todayStart, todayEnd])
      .groupBy("org_id")
      .select("org_id")
      .sum<{ org_id: number; total: string }[]>("amount as total"),
    db("tb_parking_sessions")
      .where({ status: "active" })
      .groupBy("org_id")
      .select("org_id")
      .count<{ org_id: number; count: string }[]>("id as count"),
  ]);

  const revenueMap = new Map(revenueByOrgRows.map((r) => [r.org_id, Number(r.total)]));
  const parkedMap = new Map(parkedByOrgRows.map((r) => [r.org_id, Number(r.count)]));

  const topOrganizations = organizations
    .map((org) => ({
      id: org.id,
      name: org.name,
      today_revenue: revenueMap.get(org.id) ?? 0,
      currently_parked: parkedMap.get(org.id) ?? 0,
    }))
    .sort((a, b) => b.today_revenue - a.today_revenue)
    .slice(0, 5);

  const offlineOrganizationsCount = organizations.filter(
    (org) => !computeIsOnline(org.last_heartbeat_at)
  ).length;

  return {
    total_organizations: Number(totalOrganizations),
    active_organizations: Number(activeOrganizations),
    total_revenue_today: Number(totalRevenueToday ?? 0),
    total_revenue_monthly: Number(totalRevenueMonthly ?? 0),
    total_currently_parked: Number(totalCurrentlyParked),
    offline_organizations_count: offlineOrganizationsCount,
    top_organizations: topOrganizations,
  };
}
