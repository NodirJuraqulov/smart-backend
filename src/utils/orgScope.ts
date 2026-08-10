import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";

const ORG_SCOPED_ROLES = ["operator", "owner", "kassir"] as const;

export function isOrgScopedRole(role: AuthTokenPayload["role"]): boolean {
  return (ORG_SCOPED_ROLES as readonly string[]).includes(role);
}

export function resolveOrgIdRequired(actor: AuthTokenPayload, requestedOrgId?: number): number {
  if (isOrgScopedRole(actor.role)) {
    if (!actor.org_id) {
      throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
    }
    if (requestedOrgId !== undefined && requestedOrgId !== actor.org_id) {
      throw new ApiError("Stoyanka topilmadi", 404);
    }
    return actor.org_id;
  }
  if (!requestedOrgId) {
    throw new ApiError("Super Admin uchun org_id majburiy", 400);
  }
  return requestedOrgId;
}

export function resolveOrgIdFilter(actor: AuthTokenPayload, requestedOrgId?: number): number | undefined {
  if (isOrgScopedRole(actor.role)) {
    if (!actor.org_id) {
      throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
    }
    if (requestedOrgId !== undefined && requestedOrgId !== actor.org_id) {
      throw new ApiError("Stoyanka topilmadi", 404);
    }
    return actor.org_id;
  }
  return requestedOrgId;
}
