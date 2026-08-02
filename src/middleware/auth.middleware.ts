import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { asyncHandler } from "@/middleware/asyncHandler";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { hasPermission } from "@/modules/operatorPermissions/operatorPermissions.service";

async function isAuthHandler(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ message: "Token topilmadi" });
    return;
  }

  const token = header.slice("Bearer ".length);

  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, env.jwt.secret) as AuthTokenPayload;
  } catch {
    res.status(401).json({ message: "Token yaroqsiz yoki muddati tugagan" });
    return;
  }

  const user = await db("tb_users").where({ id: payload.id }).first();
  if (!user || !user.is_active) {
    res.status(401).json({ message: "Hisob bloklangan yoki mavjud emas" });
    return;
  }

  if (user.org_id) {
    const organization = await db("tb_organizations").where({ id: user.org_id }).first();
    if (!organization || !organization.is_active) {
      res.status(401).json({ message: "Stoyanka bloklangan" });
      return;
    }
  }

  req.user = payload;
  next();
}

export const isAuth = asyncHandler(isAuthHandler);

export function isSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({ message: "Ruxsat yo'q — faqat Super Admin uchun" });
    return;
  }
  next();
}

export function isOperator(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "operator") {
    res.status(403).json({ message: "Ruxsat yo'q — faqat operator uchun" });
    return;
  }
  next();
}

export function isOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "owner") {
    res.status(403).json({ message: "Ruxsat yo'q — faqat stoyanka egasi uchun" });
    return;
  }
  next();
}

export function isOperatorOrOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "operator" && req.user?.role !== "owner") {
    res.status(403).json({ message: "Ruxsat yo'q — faqat operator yoki stoyanka egasi uchun" });
    return;
  }
  next();
}

export function isSuperAdminOrOperatorOrOwner(req: Request, res: Response, next: NextFunction) {
  if (
    req.user?.role !== "super_admin" &&
    req.user?.role !== "operator" &&
    req.user?.role !== "owner"
  ) {
    res.status(403).json({ message: "Ruxsat yo'q" });
    return;
  }
  next();
}

export function isSuperAdminOrOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "super_admin" && req.user?.role !== "owner") {
    res.status(403).json({ message: "Ruxsat yo'q — faqat Super Admin yoki stoyanka egasi uchun" });
    return;
  }
  next();
}

export function checkPermission(sectionKey: string) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "operator") {
      next();
      return;
    }

    const allowed = await hasPermission(req.user.org_id, sectionKey);
    if (!allowed) {
      res.status(403).json({ message: "Ruxsat yo'q — bu bo'limga kirish cheklangan" });
      return;
    }

    next();
  });
}
