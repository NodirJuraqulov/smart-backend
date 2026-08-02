import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { seedDefaultPermissions } from "@/modules/operatorPermissions/operatorPermissions.service";
import { ApiError } from "@/utils/ApiError";
import { isDuplicateKeyError } from "@/utils/dbErrors";
import { applyCompletedExitFilter, applyInsideSessionsFilter } from "@/modules/parking/sessionStatus";
import { encryptSecret } from "@/utils/encryption";

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
  return organizationsBaseQuery().orderBy("created_at", "desc");
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
        webhook_token: randomBytes(32).toString("hex"),
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

interface IntegrationSettings {
  id: number;
  relay_entry_ip: string | null;
  relay_exit_ip: string | null;
  printer_ip: string | null;
  camera_brand: string | null;
  webhook_token: string | null;
  last_webhook_entry_at: Date | null;
  last_webhook_exit_at: Date | null;
  gate_layout: "shared" | "separate";
  cross_camera_guard_seconds: number;
}

async function findIntegrationSettingsOrFail(id: number): Promise<IntegrationSettings> {
  const organization = await db<IntegrationSettings>("tb_organizations")
    .select(
      "id",
      "relay_entry_ip",
      "relay_exit_ip",
      "printer_ip",
      "camera_brand",
      "webhook_token",
      "last_webhook_entry_at",
      "last_webhook_exit_at",
      "gate_layout",
      "cross_camera_guard_seconds"
    )
    .where({ id })
    .first();
  if (!organization) {
    throw new ApiError("Stoyanka topilmadi", 404);
  }
  return organization;
}

export async function getIntegrationSettings(id: number): Promise<IntegrationSettings> {
  return findIntegrationSettingsOrFail(id);
}

interface UpdateIntegrationSettingsInput {
  relay_entry_ip?: string | null;
  relay_exit_ip?: string | null;
  printer_ip?: string | null;
  camera_brand?: string | null;
  gate_layout?: "shared" | "separate";
  cross_camera_guard_seconds?: number;
}

export async function updateIntegrationSettings(
  id: number,
  input: UpdateIntegrationSettingsInput
): Promise<IntegrationSettings> {
  await findIntegrationSettingsOrFail(id);

  const updates: UpdateIntegrationSettingsInput = {};
  if (input.relay_entry_ip !== undefined) updates.relay_entry_ip = input.relay_entry_ip;
  if (input.relay_exit_ip !== undefined) updates.relay_exit_ip = input.relay_exit_ip;
  if (input.printer_ip !== undefined) updates.printer_ip = input.printer_ip;
  if (input.camera_brand !== undefined) updates.camera_brand = input.camera_brand;
  if (input.gate_layout !== undefined) updates.gate_layout = input.gate_layout;
  if (input.cross_camera_guard_seconds !== undefined) {
    updates.cross_camera_guard_seconds = input.cross_camera_guard_seconds;
  }

  if (Object.keys(updates).length > 0) {
    await db("tb_organizations").where({ id }).update(updates);
  }

  return findIntegrationSettingsOrFail(id);
}

export type CameraRelayDirection = "entry" | "exit";

interface CameraRelaySettingsRow {
  id: number;
  entry_camera_relay_host: string | null;
  entry_camera_relay_port: number | null;
  entry_camera_relay_username: string | null;
  entry_camera_relay_password_encrypted: string | null;
  entry_camera_relay_channel: number | null;
  exit_camera_relay_host: string | null;
  exit_camera_relay_port: number | null;
  exit_camera_relay_username: string | null;
  exit_camera_relay_password_encrypted: string | null;
  exit_camera_relay_channel: number | null;
}

export interface CameraRelaySettingsInput {
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  channel?: number | null;
}

async function findCameraRelaySettingsOrFail(id: number): Promise<CameraRelaySettingsRow> {
  const organization = await db<CameraRelaySettingsRow>("tb_organizations")
    .select(
      "id",
      "entry_camera_relay_host",
      "entry_camera_relay_port",
      "entry_camera_relay_username",
      "entry_camera_relay_password_encrypted",
      "entry_camera_relay_channel",
      "exit_camera_relay_host",
      "exit_camera_relay_port",
      "exit_camera_relay_username",
      "exit_camera_relay_password_encrypted",
      "exit_camera_relay_channel"
    )
    .where({ id })
    .first();
  if (!organization) throw new ApiError("Stoyanka topilmadi", 404);
  return organization;
}

function publicCameraRelaySettings(row: CameraRelaySettingsRow, direction: CameraRelayDirection) {
  const host = direction === "entry" ? row.entry_camera_relay_host : row.exit_camera_relay_host;
  const port = direction === "entry" ? row.entry_camera_relay_port : row.exit_camera_relay_port;
  const username = direction === "entry" ? row.entry_camera_relay_username : row.exit_camera_relay_username;
  const password =
    direction === "entry"
      ? row.entry_camera_relay_password_encrypted
      : row.exit_camera_relay_password_encrypted;
  const channel = direction === "entry" ? row.entry_camera_relay_channel : row.exit_camera_relay_channel;
  return {
    configured: Boolean(host && username && password),
    host,
    port: port ?? 80,
    username,
    channel: channel ?? 1,
  };
}

export async function getCameraRelaySettings(id: number) {
  const row = await findCameraRelaySettingsOrFail(id);
  return {
    entry: publicCameraRelaySettings(row, "entry"),
    exit: publicCameraRelaySettings(row, "exit"),
  };
}

export async function updateCameraRelaySettings(
  id: number,
  input: { entry?: CameraRelaySettingsInput; exit?: CameraRelaySettingsInput }
) {
  await findCameraRelaySettingsOrFail(id);
  const updates: Record<string, unknown> = {};
  for (const direction of ["entry", "exit"] as const) {
    const settings = input[direction];
    if (!settings) continue;
    if (settings.host !== undefined) updates[`${direction}_camera_relay_host`] = settings.host;
    if (settings.port !== undefined) updates[`${direction}_camera_relay_port`] = settings.port;
    if (settings.username !== undefined) updates[`${direction}_camera_relay_username`] = settings.username;
    if (settings.channel !== undefined) updates[`${direction}_camera_relay_channel`] = settings.channel;
    if (settings.password !== undefined) {
      updates[`${direction}_camera_relay_password_encrypted`] = settings.password
        ? encryptSecret(settings.password)
        : null;
    }
  }
  if (Object.keys(updates).length > 0) {
    await db("tb_organizations").where({ id }).update(updates);
  }
  return getCameraRelaySettings(id);
}

export async function regenerateWebhookToken(id: number): Promise<string> {
  await findIntegrationSettingsOrFail(id);

  const token = randomBytes(32).toString("hex");
  await db("tb_organizations").where({ id }).update({ webhook_token: token });

  return token;
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
  const today = now.toFormat("yyyy-MM-dd");

  const [
    [todayEntries],
    [todayExits],
    [todayRevenue],
    [currentlyParked],
    [totalSessions],
    [totalRevenue],
    [todaySubscriptionRevenue],
    [totalSubscriptionRevenue],
  ] = await Promise.all([
    db("tb_parking_sessions")
      .where({ org_id: id })
      .whereBetween("entered_at", [todayStart, todayEnd])
      .count<{ count: string }[]>("id as count"),
    applyCompletedExitFilter(
      db("tb_parking_sessions").where({ org_id: id })
    )
      .whereBetween("exited_at", [todayStart, todayEnd])
      .count<{ count: string }[]>("id as count"),
    db("tb_payments")
      .where({ org_id: id })
      .whereBetween("paid_at", [todayStart, todayEnd])
      .sum<{ total: string | null }[]>("amount as total"),
    applyInsideSessionsFilter(
      db("tb_parking_sessions").where({ org_id: id })
    )
      .count<{ count: string }[]>("id as count"),
    db("tb_parking_sessions").where({ org_id: id }).count<{ count: string }[]>("id as count"),
    db("tb_payments").where({ org_id: id }).sum<{ total: string | null }[]>("amount as total"),
    db("tb_subscriptions")
      .where({ org_id: id })
      .andWhere((builder) => {
        builder
          .whereBetween("created_at", [todayStart, todayEnd])
          .orWhereBetween("last_renewed_at", [today, today]);
      })
      .sum<{ total: string | null }[]>("price_snapshot as total"),
    db("tb_subscriptions")
      .where({ org_id: id })
      .sum<{ total: string | null }[]>("price_snapshot as total"),
  ]);

  return {
    organization_id: id,
    today_entries: Number(todayEntries.count),
    today_exits: Number(todayExits.count),
    today_revenue: Number(todayRevenue.total ?? 0) + Number(todaySubscriptionRevenue.total ?? 0),
    currently_parked: Number(currentlyParked.count),
    total_sessions: Number(totalSessions.count),
    total_revenue: Number(totalRevenue.total ?? 0) + Number(totalSubscriptionRevenue.total ?? 0),
  };
}

export async function getGlobalStats() {
  const now = DateTime.now().setZone(env.platformDefaultTimezone);
  const todayStart = now.startOf("day").toJSDate();
  const todayEnd = now.endOf("day").toJSDate();
  const monthStart = now.startOf("month").toJSDate();
  const monthEnd = now.endOf("month").toJSDate();
  const today = now.toFormat("yyyy-MM-dd");
  const monthStartDate = now.startOf("month").toFormat("yyyy-MM-dd");
  const monthEndDate = now.endOf("month").toFormat("yyyy-MM-dd");

  const [
    [{ count: totalOrganizations }],
    [{ count: activeOrganizations }],
    [{ total: totalRevenueToday }],
    [{ total: totalRevenueMonthly }],
    [{ total: totalSubscriptionRevenueToday }],
    [{ total: totalSubscriptionRevenueMonthly }],
    [{ count: totalCurrentlyParked }],
    organizations,
    revenueByOrgRows,
    subscriptionRevenueByOrgRows,
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
    db("tb_subscriptions")
      .andWhere((builder) => {
        builder
          .whereBetween("created_at", [todayStart, todayEnd])
          .orWhereBetween("last_renewed_at", [today, today]);
      })
      .sum<{ total: string | null }[]>("price_snapshot as total"),
    db("tb_subscriptions")
      .andWhere((builder) => {
        builder
          .whereBetween("created_at", [monthStart, monthEnd])
          .orWhereBetween("last_renewed_at", [monthStartDate, monthEndDate]);
      })
      .sum<{ total: string | null }[]>("price_snapshot as total"),
    applyInsideSessionsFilter(db("tb_parking_sessions")).count<{ count: string }[]>("id as count"),
    db("tb_organizations").select("id", "name"),
    db("tb_payments")
      .whereBetween("paid_at", [todayStart, todayEnd])
      .groupBy("org_id")
      .select("org_id")
      .sum<{ org_id: number; total: string }[]>("amount as total"),
    db("tb_subscriptions")
      .andWhere((builder) => {
        builder
          .whereBetween("created_at", [todayStart, todayEnd])
          .orWhereBetween("last_renewed_at", [today, today]);
      })
      .groupBy("org_id")
      .select("org_id")
      .sum<{ org_id: number; total: string }[]>("price_snapshot as total"),
    applyInsideSessionsFilter(db("tb_parking_sessions"))
      .groupBy("org_id")
      .select("org_id")
      .count<{ org_id: number; count: string }[]>("id as count"),
  ]);

  const revenueMap = new Map(revenueByOrgRows.map((r) => [r.org_id, Number(r.total)]));
  for (const row of subscriptionRevenueByOrgRows) {
    revenueMap.set(row.org_id, (revenueMap.get(row.org_id) ?? 0) + Number(row.total));
  }
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

  return {
    total_organizations: Number(totalOrganizations),
    active_organizations: Number(activeOrganizations),
    total_revenue_today: Number(totalRevenueToday ?? 0) + Number(totalSubscriptionRevenueToday ?? 0),
    total_revenue_monthly: Number(totalRevenueMonthly ?? 0) + Number(totalSubscriptionRevenueMonthly ?? 0),
    total_currently_parked: Number(totalCurrentlyParked),
    top_organizations: topOrganizations,
  };
}
