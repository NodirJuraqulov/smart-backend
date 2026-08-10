import bcrypt from "bcrypt";
import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";
import { isDuplicateKeyError } from "@/utils/dbErrors";

interface UserRow {
  id: number;
  org_id: number | null;
  name: string;
  login: string;
  password: string;
  role: "super_admin" | "operator" | "owner" | "kassir";
  is_active: boolean;
  created_at: Date;
}

export type ManagedUserRole = "operator" | "kassir";

const MANAGED_ROLES = ["operator", "owner", "kassir"] as const;

interface CreateOperatorInput {
  org_id: number;
  name: string;
  login: string;
  password: string;
  role?: ManagedUserRole;
}

interface UpdateOperatorInput {
  org_id?: number;
  name?: string;
  login?: string;
  password?: string;
}

function toPublicOperator(row: UserRow) {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    login: row.login,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
  };
}

async function findManagedUserRowOrFail(id: number) {
  const user = await db<UserRow>("tb_users").where({ id }).whereIn("role", [...MANAGED_ROLES]).first();
  if (!user) {
    throw new ApiError("Foydalanuvchi topilmadi", 404);
  }
  return user;
}

async function assertLoginAvailable(login: string, excludeId?: number) {
  const query = db("tb_users").where({ login });
  if (excludeId !== undefined) {
    query.whereNot({ id: excludeId });
  }
  const existing = await query.first();
  if (existing) {
    throw new ApiError("Bu login allaqachon band", 409);
  }
}

export async function listOperators() {
  const rows = await db<UserRow>("tb_users")
    .whereIn("role", [...MANAGED_ROLES])
    .orderBy("created_at", "desc");
  return rows.map(toPublicOperator);
}

export async function createOperator(input: CreateOperatorInput) {
  await assertOrganizationExists(input.org_id);
  await assertLoginAvailable(input.login);

  const passwordHash = await bcrypt.hash(input.password, 10);

  let id: number;
  try {
    [id] = await db("tb_users").insert({
      org_id: input.org_id,
      name: input.name,
      login: input.login,
      password: passwordHash,
      role: input.role ?? "operator",
      is_active: true,
    });
  } catch (err) {
    if (isDuplicateKeyError(err, "tb_users_login_unique")) {
      throw new ApiError("Bu login allaqachon band", 409);
    }
    throw err;
  }

  const row = await db<UserRow>("tb_users").where({ id }).first();
  return toPublicOperator(row!);
}

export async function updateOperator(id: number, input: UpdateOperatorInput) {
  const operator = await findManagedUserRowOrFail(id);

  if (input.org_id !== undefined) {
    await assertOrganizationExists(input.org_id);
  }
  if (input.login !== undefined) {
    await assertLoginAvailable(input.login, id);
  }

  const updates: Record<string, unknown> = {};
  if (input.org_id !== undefined) updates.org_id = input.org_id;
  if (input.name !== undefined) updates.name = input.name;
  if (input.login !== undefined) updates.login = input.login;
  if (input.password !== undefined) updates.password = await bcrypt.hash(input.password, 10);

  if (Object.keys(updates).length > 0) {
    try {
      await db("tb_users").where({ id }).update(updates);
    } catch (err) {
      if (isDuplicateKeyError(err, "tb_users_login_unique")) {
        throw new ApiError("Bu login allaqachon band", 409);
      }
      throw err;
    }
  }

  return toPublicOperator({ ...operator, ...updates });
}

export async function toggleBlockOperator(id: number, isActive?: boolean) {
  const operator = await findManagedUserRowOrFail(id);

  const nextValue = isActive !== undefined ? isActive : !operator.is_active;
  await db("tb_users").where({ id }).update({ is_active: nextValue });

  return toPublicOperator({ ...operator, is_active: nextValue });
}
