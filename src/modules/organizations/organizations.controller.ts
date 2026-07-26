import { isIP } from "net";
import { Request, Response } from "express";
import { openBarrier } from "@/modules/relay/relay.service";
import { printReceipt } from "@/modules/printer/printer.service";
import { logActivity } from "@/utils/activityLog";
import { parseId } from "@/utils/httpParams";
import { assertValidLogin, assertValidPassword } from "@/utils/validation";
import * as organizationsService from "./organizations.service";

const DEFAULT_CAMERA_BRAND = "hikvision";

function isValidOptionalIp(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (typeof value === "string" && isIP(value) !== 0);
}

function buildWebhookUrl(
  baseUrl: string,
  cameraBrand: string | null,
  webhookToken: string | null,
  direction: "entry" | "exit"
): string | null {
  if (!webhookToken) return null;
  const brand = cameraBrand || DEFAULT_CAMERA_BRAND;
  return `${baseUrl}/api/webhook/${brand}/${webhookToken}/${direction}`;
}

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

export async function getIntegrationSettingsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const settings = await organizationsService.getIntegrationSettings(id);
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  res.json({
    relayEntryIp: settings.relay_entry_ip,
    relayExitIp: settings.relay_exit_ip,
    printerIp: settings.printer_ip,
    cameraBrand: settings.camera_brand,
    webhookToken: settings.webhook_token,
    webhookEntryUrl: buildWebhookUrl(baseUrl, settings.camera_brand, settings.webhook_token, "entry"),
    webhookExitUrl: buildWebhookUrl(baseUrl, settings.camera_brand, settings.webhook_token, "exit"),
    lastWebhookEntryAt: settings.last_webhook_entry_at,
    lastWebhookExitAt: settings.last_webhook_exit_at,
  });
}

export async function updateIntegrationSettingsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { relay_entry_ip, relay_exit_ip, printer_ip, camera_brand } = req.body ?? {};

  if (!isValidOptionalIp(relay_entry_ip)) {
    res.status(400).json({ message: "relay_entry_ip to'g'ri IP manzil formatida yoki bo'sh bo'lishi kerak" });
    return;
  }
  if (!isValidOptionalIp(relay_exit_ip)) {
    res.status(400).json({ message: "relay_exit_ip to'g'ri IP manzil formatida yoki bo'sh bo'lishi kerak" });
    return;
  }
  if (!isValidOptionalIp(printer_ip)) {
    res.status(400).json({ message: "printer_ip to'g'ri IP manzil formatida yoki bo'sh bo'lishi kerak" });
    return;
  }
  if (camera_brand !== undefined && camera_brand !== null && typeof camera_brand !== "string") {
    res.status(400).json({ message: "camera_brand satr bo'lishi kerak" });
    return;
  }

  const settings = await organizationsService.updateIntegrationSettings(id, {
    relay_entry_ip: relay_entry_ip === "" ? null : relay_entry_ip,
    relay_exit_ip: relay_exit_ip === "" ? null : relay_exit_ip,
    printer_ip: printer_ip === "" ? null : printer_ip,
    camera_brand: camera_brand === "" ? null : camera_brand,
  });

  await logActivity(req.user!.id, "organization.integration_settings_updated", "organization", id, {
    relay_entry_ip: settings.relay_entry_ip,
    relay_exit_ip: settings.relay_exit_ip,
    printer_ip: settings.printer_ip,
    camera_brand: settings.camera_brand,
  });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    relayEntryIp: settings.relay_entry_ip,
    relayExitIp: settings.relay_exit_ip,
    printerIp: settings.printer_ip,
    cameraBrand: settings.camera_brand,
    webhookToken: settings.webhook_token,
    webhookEntryUrl: buildWebhookUrl(baseUrl, settings.camera_brand, settings.webhook_token, "entry"),
    webhookExitUrl: buildWebhookUrl(baseUrl, settings.camera_brand, settings.webhook_token, "exit"),
  });
}

export async function regenerateWebhookTokenHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const webhookToken = await organizationsService.regenerateWebhookToken(id);

  await logActivity(req.user!.id, "organization.webhook_token_regenerated", "organization", id);

  res.json({ webhookToken });
}

export async function relayTestHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const { direction } = req.body ?? {};
  if (direction !== "entry" && direction !== "exit") {
    res.status(400).json({ message: "direction 'entry' yoki 'exit' bo'lishi kerak" });
    return;
  }

  const success = await openBarrier(id, direction);
  res.json({ success });
}

export async function printerTestHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const settings = await organizationsService.getIntegrationSettings(id);
  if (!settings.printer_ip) {
    res.json({ success: false, reason: "printer_not_configured" });
    return;
  }

  const now = new Date();
  const success = await printReceipt(settings.printer_ip, {
    orgName: "Sinov chek",
    plateNumber: "TEST123",
    enteredAt: now,
    exitedAt: now,
    durationMinutes: 0,
    amount: 0,
    paymentMethod: "cash",
    issuedAt: now,
  });

  res.json({ success });
}
