import { AuthTokenPayload } from "@/modules/auth/auth.service";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      webhookOrgId?: number;
      webhookPlateFormatValidationEnabled?: boolean;
      medplusOrgId?: number;
    }
  }
}

export {};
