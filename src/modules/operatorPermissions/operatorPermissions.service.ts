import type { Knex } from "knex";
import type { UserRole } from "@/modules/auth/auth.service";
import { db } from "@/config/db";
import { ApiError } from "@/utils/ApiError";
import { assertOrganizationExists } from "@/utils/assertOrganizationExists";

export const SECTION_KEYS = [
  "dashboard",
  "sessions",
  "reports",
  "tariffs",
  "subscriptions",
  "settings",
  "activity_log",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const KASSIR_SECTION_KEYS: readonly SectionKey[] = ["reports"];

interface PermissionRecord {
  id: number;
  org_id: number;
  section_key: string;
  can_view: boolean;
}

interface PermissionInput {
  section_key: string;
  can_view: boolean;
}

export async function seedDefaultPermissions(trx: Knex, orgId: number): Promise<void> {
  await trx("tb_operator_permissions").insert(
    SECTION_KEYS.map((sectionKey) => ({ org_id: orgId, section_key: sectionKey, can_view: true }))
  );
}

export async function listPermissions(orgId: number) {
  await assertOrganizationExists(orgId);
  const rows = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId })
    .select("section_key", "can_view")
    .orderBy("section_key", "asc");
  return rows.map((row) => ({ section_key: row.section_key, can_view: !!row.can_view }));
}

export async function updatePermissions(orgId: number, permissions: PermissionInput[]) {
  await assertOrganizationExists(orgId);

  for (const permission of permissions) {
    if (!SECTION_KEYS.includes(permission.section_key as SectionKey)) {
      throw new ApiError(`Noto'g'ri section_key: "${permission.section_key}"`, 400);
    }
    if (typeof permission.can_view !== "boolean") {
      throw new ApiError("can_view boolean bo'lishi kerak", 400);
    }
  }

  await db.transaction(async (trx) => {
    for (const permission of permissions) {
      await trx("tb_operator_permissions")
        .where({ org_id: orgId, section_key: permission.section_key })
        .update({ can_view: permission.can_view });
    }
  });

  return listPermissions(orgId);
}

export async function hasPermission(orgId: number | null, sectionKey: string): Promise<boolean> {
  if (!orgId) return true;

  const permission = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId, section_key: sectionKey })
    .first();

  return permission ? !!permission.can_view : true;
}

export async function canAccessSection(
  role: UserRole,
  orgId: number | null,
  sectionKey: string
): Promise<boolean> {
  if (role === "kassir") {
    return (KASSIR_SECTION_KEYS as readonly string[]).includes(sectionKey);
  }
  if (role !== "operator") return true;
  return hasPermission(orgId, sectionKey);
}

export async function getPermissionsMap(
  orgId: number | null,
  role: UserRole
): Promise<Record<string, boolean>> {
  const map = Object.fromEntries(SECTION_KEYS.map((key) => [key, true])) as Record<string, boolean>;

  if (role === "kassir") {
    return Object.fromEntries(
      SECTION_KEYS.map((key) => [key, (KASSIR_SECTION_KEYS as readonly string[]).includes(key)])
    ) as Record<string, boolean>;
  }

  if (role === "super_admin" || role === "owner" || !orgId) {
    return map;
  }

  const rows = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId })
    .select("section_key", "can_view");

  for (const row of rows) {
    map[row.section_key] = !!row.can_view;
  }

  return map;
}
