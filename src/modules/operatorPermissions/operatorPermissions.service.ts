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

export const PERMISSION_ROLES = ["operator", "kassir"] as const;

export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export const KASSIR_DEFAULT_VISIBLE_SECTIONS: readonly SectionKey[] = ["reports"];

export function isPermissionRole(value: unknown): value is PermissionRole {
  return (PERMISSION_ROLES as readonly unknown[]).includes(value);
}

function defaultCanView(role: PermissionRole, sectionKey: SectionKey): boolean {
  return role === "operator" || KASSIR_DEFAULT_VISIBLE_SECTIONS.includes(sectionKey);
}

interface PermissionRecord {
  id: number;
  org_id: number;
  role: PermissionRole;
  section_key: string;
  can_view: boolean;
}

interface PermissionInput {
  section_key: string;
  can_view: boolean;
}

export async function seedDefaultPermissions(trx: Knex, orgId: number): Promise<void> {
  await trx("tb_operator_permissions").insert(
    PERMISSION_ROLES.flatMap((role) =>
      SECTION_KEYS.map((sectionKey) => ({
        org_id: orgId,
        role,
        section_key: sectionKey,
        can_view: defaultCanView(role, sectionKey),
      }))
    )
  );
}

export async function listPermissions(orgId: number, role: PermissionRole = "operator") {
  await assertOrganizationExists(orgId);
  const rows = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId, role })
    .select("section_key", "can_view")
    .orderBy("section_key", "asc");
  return rows.map((row) => ({ section_key: row.section_key, can_view: !!row.can_view }));
}

export async function updatePermissions(
  orgId: number,
  permissions: PermissionInput[],
  role: PermissionRole = "operator"
) {
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
      const updated = await trx("tb_operator_permissions")
        .where({ org_id: orgId, role, section_key: permission.section_key })
        .update({ can_view: permission.can_view });
      if (updated === 0) {
        await trx("tb_operator_permissions").insert({
          org_id: orgId,
          role,
          section_key: permission.section_key,
          can_view: permission.can_view,
        });
      }
    }
  });

  return listPermissions(orgId, role);
}

export async function hasPermission(
  orgId: number | null,
  sectionKey: string,
  role: PermissionRole = "operator"
): Promise<boolean> {
  if (!orgId) return true;

  const permission = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId, role, section_key: sectionKey })
    .first();

  return permission ? !!permission.can_view : defaultCanView(role, sectionKey as SectionKey);
}

export async function canAccessSection(
  role: UserRole,
  orgId: number | null,
  sectionKey: string
): Promise<boolean> {
  if (!isPermissionRole(role)) return true;
  return hasPermission(orgId, sectionKey, role);
}

export async function getPermissionsMap(
  orgId: number | null,
  role: UserRole
): Promise<Record<string, boolean>> {
  if (!isPermissionRole(role) || !orgId) {
    return Object.fromEntries(SECTION_KEYS.map((key) => [key, true])) as Record<string, boolean>;
  }

  const map = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, defaultCanView(role, key)])
  ) as Record<string, boolean>;

  const rows = await db<PermissionRecord>("tb_operator_permissions")
    .where({ org_id: orgId, role })
    .select("section_key", "can_view");

  for (const row of rows) {
    map[row.section_key] = !!row.can_view;
  }

  return map;
}
