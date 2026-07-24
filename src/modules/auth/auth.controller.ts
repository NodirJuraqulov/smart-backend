import { Request, Response } from "express";
import { getPermissionsMap } from "@/modules/operatorPermissions/operatorPermissions.service";
import {
  AuthError,
  getUserById,
  login as loginService,
  logout as logoutService,
  refreshAccessToken,
} from "./auth.service";

export async function loginHandler(req: Request, res: Response) {
  const { login, password } = req.body ?? {};

  if (!login || !password) {
    res.status(400).json({ message: "login va password majburiy" });
    return;
  }

  try {
    const result = await loginService(login, password);
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }
    throw err;
  }
}

export async function refreshHandler(req: Request, res: Response) {
  const { refreshToken } = req.body ?? {};

  try {
    const token = await refreshAccessToken(refreshToken);
    res.json({ token });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }
    throw err;
  }
}

export async function logoutHandler(req: Request, res: Response) {
  const { refreshToken } = req.body ?? {};
  await logoutService(refreshToken);
  res.json({ message: "Tizimdan muvaffaqiyatli chiqdingiz" });
}

export async function meHandler(req: Request, res: Response) {
  const user = await getUserById(req.user!.id);
  if (!user) {
    res.status(404).json({ message: "Foydalanuvchi topilmadi" });
    return;
  }
  const permissions = await getPermissionsMap(user.org_id, user.role);
  res.json({ user, permissions });
}
