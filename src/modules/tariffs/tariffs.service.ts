import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { resolveOrgIdFilter } from "@/utils/orgScope";

interface TariffRecord {
  id: number;
  org_id: number;
  name: string;
  price_per_hour: string;
  grace_period_minutes: number;
  created_at: Date;
}

interface CreateTariffInput {
  org_id?: number;
  name: string;
  price_per_hour: number;
  grace_period_minutes?: number;
}

interface UpdateTariffInput {
  name?: string;
  price_per_hour?: number;
  grace_period_minutes?: number;
}

async function findTariffOrFail(id: number) {
  const tariff = await db<TariffRecord>("tb_tariffs").where({ id }).first();
  if (!tariff) {
    throw new ApiError("Tarif topilmadi", 404);
  }
  return tariff;
}

function assertOperatorOwnsTariff(actor: AuthTokenPayload, tariff: TariffRecord) {
  if (tariff.org_id !== actor.org_id) {
    throw new ApiError("Tarif topilmadi", 404);
  }
}

export async function listTariffs(actor: AuthTokenPayload, requestedOrgId?: number) {
  const orgId = resolveOrgIdFilter(actor, requestedOrgId);

  const query = db<TariffRecord>("tb_tariffs").orderBy("created_at", "desc");
  if (orgId !== undefined) {
    query.where({ org_id: orgId });
  }
  return query;
}

export async function createTariff(actor: AuthTokenPayload, input: CreateTariffInput) {
  let orgId: number;

  if (actor.role === "operator" || actor.role === "owner") {
    if (!actor.org_id) {
      throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
    }
    orgId = actor.org_id;
  } else {
    if (!input.org_id) {
      throw new ApiError("Super Admin uchun org_id majburiy", 400);
    }
    orgId = input.org_id;
    await assertOrganizationExists(orgId);
  }

  return db.transaction(async (trx) => {
    const existing = await trx<TariffRecord>("tb_tariffs").where({ org_id: orgId }).first();
    if (existing) {
      throw new ApiError("Bu stoyanka uchun tarif allaqachon mavjud, faqat tahrirlash mumkin", 400);
    }

    const [id] = await trx("tb_tariffs").insert({
      org_id: orgId,
      name: input.name,
      price_per_hour: input.price_per_hour,
      grace_period_minutes: input.grace_period_minutes ?? 0,
    });

    return trx<TariffRecord>("tb_tariffs").where({ id }).first();
  });
}

export async function updateTariff(actor: AuthTokenPayload, id: number, input: UpdateTariffInput) {
  const tariff = await findTariffOrFail(id);

  if (actor.role === "operator" || actor.role === "owner") {
    assertOperatorOwnsTariff(actor, tariff);
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.price_per_hour !== undefined) updates.price_per_hour = input.price_per_hour;
  if (input.grace_period_minutes !== undefined) updates.grace_period_minutes = input.grace_period_minutes;

  if (Object.keys(updates).length > 0) {
    await db("tb_tariffs").where({ id }).update(updates);
  }

  return db<TariffRecord>("tb_tariffs").where({ id }).first();
}
