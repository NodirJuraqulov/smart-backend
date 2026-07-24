import { Request, Response } from "express";
import { logActivity } from "@/utils/activityLog";
import { parseId } from "@/utils/httpParams";
import { assertValidLogin, assertValidPassword } from "@/utils/validation";
import * as organizationsService from "./organizations.service";

export async function listHandler(req: Request, res: Response) {
  const organizations = await organizationsService.listOrganizations();
  res.json({ organizations });
}

export async function createHandler(req: Request, res: Response) {
  const { name, address, timezone, owner, operator, tariff } = req.body ?? {};

  if (!name || !owner?.name || !owner?.login || !owner?.password) {
    res.status(400).json({
      message: "name, owner.name, owner.login, owner.password majburiy",
    });
    return;
  }

  if (!tariff || tariff.price_per_hour === undefined) {
    res.status(400).json({ message: "tariff.price_per_hour majburiy" });
    return;
  }

  assertValidLogin(owner.login);
  assertValidPassword(owner.password);

  if (operator) {
    if (!operator.name || !operator.login || !operator.password) {
      res.status(400).json({
        message: "operator yuborilsa, operator.name, operator.login, operator.password majburiy",
      });
      return;
    }
    assertValidLogin(operator.login);
    assertValidPassword(operator.password);
  }

  const result = await organizationsService.createOrganization({
    name,
    address,
    timezone,
    owner,
    operator,
    tariff,
  });

  await logActivity(req.user!.id, "organization.created", "organization", result.organization?.id, {
    name,
    address,
    timezone,
  });

  res.status(201).json(result);
}

export async function addOperatorHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { name, login, password } = req.body ?? {};
  if (!name || !login || !password) {
    res.status(400).json({ message: "name, login, password majburiy" });
    return;
  }

  assertValidLogin(login);
  assertValidPassword(password);

  const operator = await organizationsService.addOperator(id, { name, login, password });

  await logActivity(req.user!.id, "organization.operator_added", "organization", id, { name, login });

  res.status(201).json({ operator });
}

export async function updateHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { name, address, timezone } = req.body ?? {};

  const organization = await organizationsService.updateOrganization(id, { name, address, timezone });

  await logActivity(req.user!.id, "organization.updated", "organization", id, { name, address, timezone });

  res.json({ organization });
}

export async function blockHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { is_active } = req.body ?? {};

  const organization = await organizationsService.toggleBlockOrganization(
    id,
    typeof is_active === "boolean" ? is_active : undefined
  );

  await logActivity(
    req.user!.id,
    organization.is_active ? "organization.unblocked" : "organization.blocked",
    "organization",
    id
  );

  res.json({ organization });
}

export async function pricingModeHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { pricing_mode } = req.body ?? {};
  if (pricing_mode !== "hourly" && pricing_mode !== "interval") {
    res.status(400).json({ message: "pricing_mode 'hourly' yoki 'interval' bo'lishi kerak" });
    return;
  }

  const organization = await organizationsService.updatePricingMode(id, pricing_mode);

  await logActivity(req.user!.id, "organization.pricing_mode_updated", "organization", id, { pricing_mode });

  res.json({ organization });
}

export async function capacityHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { total_capacity } = req.body ?? {};
  if (
    total_capacity !== null &&
    (typeof total_capacity !== "number" || !Number.isInteger(total_capacity) || total_capacity < 0)
  ) {
    res.status(400).json({ message: "total_capacity manfiy bo'lmagan butun son yoki null bo'lishi kerak" });
    return;
  }

  const organization = await organizationsService.updateCapacity(id, total_capacity);

  await logActivity(req.user!.id, "organization.capacity_updated", "organization", id, { total_capacity });

  res.json({ organization });
}

export async function statsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const stats = await organizationsService.getOrganizationStats(id);
  res.json(stats);
}

export async function globalStatsHandler(req: Request, res: Response) {
  const stats = await organizationsService.getGlobalStats();
  res.json(stats);
}
