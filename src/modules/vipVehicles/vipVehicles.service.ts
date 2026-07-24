import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { isDuplicateKeyError } from "@/utils/dbErrors";

interface VipRecord {
  id: number;
  org_id: number;
  plate_number: string;
  note: string | null;
  created_at: Date;
}

interface CreateVipInput {
  plate_number: string;
  note?: string | null;
}

interface UpdateVipInput {
  plate_number?: string;
  note?: string | null;
}

function requireOrgId(actor: AuthTokenPayload): number {
  if (!actor.org_id) {
    throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
  }
  return actor.org_id;
}

async function findVipOrFail(id: number) {
  const vip = await db<VipRecord>("tb_vip_vehicles").where({ id }).first();
  if (!vip) {
    throw new ApiError("VIP mashina topilmadi", 404);
  }
  return vip;
}

function assertInScope(actor: AuthTokenPayload, vip: VipRecord) {
  if (vip.org_id !== actor.org_id) {
    throw new ApiError("VIP mashina topilmadi", 404);
  }
}

export async function listVipVehicles(actor: AuthTokenPayload) {
  const orgId = requireOrgId(actor);
  return db<VipRecord>("tb_vip_vehicles").where({ org_id: orgId }).orderBy("created_at", "desc");
}

export async function createVipVehicle(actor: AuthTokenPayload, input: CreateVipInput) {
  const orgId = requireOrgId(actor);

  if (!input.plate_number) {
    throw new ApiError("plate_number majburiy", 400);
  }

  try {
    const [id] = await db("tb_vip_vehicles").insert({
      org_id: orgId,
      plate_number: input.plate_number,
      note: input.note ?? null,
    });
    return db<VipRecord>("tb_vip_vehicles").where({ id }).first();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new ApiError("Bu nomer allaqachon VIP ro'yxatida", 409);
    }
    throw err;
  }
}

export async function updateVipVehicle(actor: AuthTokenPayload, id: number, input: UpdateVipInput) {
  const vip = await findVipOrFail(id);
  assertInScope(actor, vip);

  const updates: Record<string, unknown> = {};
  if (input.plate_number !== undefined) updates.plate_number = input.plate_number;
  if (input.note !== undefined) updates.note = input.note;

  if (Object.keys(updates).length > 0) {
    try {
      await db("tb_vip_vehicles").where({ id }).update(updates);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ApiError("Bu nomer allaqachon VIP ro'yxatida", 409);
      }
      throw err;
    }
  }

  return db<VipRecord>("tb_vip_vehicles").where({ id }).first();
}

export async function deleteVipVehicle(actor: AuthTokenPayload, id: number) {
  const vip = await findVipOrFail(id);
  assertInScope(actor, vip);
  await db("tb_vip_vehicles").where({ id }).del();
}
