import { Request, Response } from "express";
import { logActivity } from "@/utils/activityLog";
import { parseId } from "@/utils/httpParams";
import { assertValidLogin, assertValidPassword } from "@/utils/validation";
import * as usersService from "./users.service";

export async function listHandler(req: Request, res: Response) {
  const operators = await usersService.listOperators();
  res.json({ operators });
}

export async function createHandler(req: Request, res: Response) {
  const { org_id, name, login, password, role } = req.body ?? {};

  if (!org_id || !name || !login || !password) {
    res.status(400).json({ message: "org_id, name, login, password majburiy" });
    return;
  }

  if (role !== undefined && role !== "operator" && role !== "kassir") {
    res.status(400).json({ message: "role 'operator' yoki 'kassir' bo'lishi kerak" });
    return;
  }

  assertValidLogin(login);
  assertValidPassword(password);

  const operator = await usersService.createOperator({ org_id, name, login, password, role });

  await logActivity(req.user!.id, "user.created", "user", operator.id, { org_id, name, login, role });

  res.status(201).json({ operator });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { org_id, name, login, password } = req.body ?? {};

  if (login !== undefined) assertValidLogin(login);
  if (password !== undefined) assertValidPassword(password);

  const operator = await usersService.updateOperator(id, { org_id, name, login, password });

  await logActivity(req.user!.id, "user.updated", "user", id, { org_id, name, login });

  res.json({ operator });
}

export async function blockHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { is_active } = req.body ?? {};

  const operator = await usersService.toggleBlockOperator(
    id,
    typeof is_active === "boolean" ? is_active : undefined
  );

  await logActivity(
    req.user!.id,
    operator.is_active ? "user.unblocked" : "user.blocked",
    "user",
    id
  );

  res.json({ operator });
}
