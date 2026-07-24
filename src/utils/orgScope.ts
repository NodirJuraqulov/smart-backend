import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";

export function resolveOrgIdRequired(actor: AuthTokenPayload, requestedOrgId?: number): number {
  if (actor.role === "operator" || actor.role === "owner") {
    if (!actor.org_id) {
      throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
    }
    return actor.org_id;
  }
  if (!requestedOrgId) {
    throw new ApiError("Super Admin uchun org_id majburiy", 400);
  }
  return requestedOrgId;
}

export function resolveOrgIdFilter(actor: AuthTokenPayload, requestedOrgId?: number): number | undefined {
  if (actor.role === "operator" || actor.role === "owner") {
    if (!actor.org_id) {
      throw new ApiError("Operator hech qanday stoyankaga biriktirilmagan", 400);
    }
    return actor.org_id;
  }
  return requestedOrgId;
}
