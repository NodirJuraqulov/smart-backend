import { AuthTokenPayload } from "@/modules/auth/auth.service";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      orgId?: number;
    }
  }
}

export {};
