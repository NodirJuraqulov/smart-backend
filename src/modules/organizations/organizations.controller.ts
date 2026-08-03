import { isIP } from "net";
import { Request, Response } from "express";
import { env } from "@/config/env";
import { printReceipt } from "@/modules/printer/printer.service";
import { logActivity } from "@/utils/activityLog";
import { parseId } from "@/utils/httpParams";
import { assertValidLogin, assertValidPassword } from "@/utils/validation";
import * as organizationsService from "./organizations.service";
import { resetOrganizationTestData } from "./organizationTestDataReset.service";

const DEFAULT_CAMERA_BRAND = "hikvision";
const DEBUG_CAMERA_BRAND = "debug";

function isValidOptionalIp(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (typeof value === "string" && isIP(value) !== 0);
}

function buildWebhookUrl(
  cameraBrand: string | null,
  webhookToken: string | null,
  direction: "entry" | "exit"
): string | null {
  if (!webhookToken) return null;
  const brand = cameraBrand || DEFAULT_CAMERA_BRAND;
  return `${env.publicBaseUrl}/api/webhook/${brand}/${webhookToken}/${direction}`;
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

export async function resetTestDataHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;
  if (req.body?.confirmation !== "RESET") {
    res.status(400).json({ message: "Tasdiqlash uchun confirmation maydoni aniq 'RESET' bo'lishi kerak" });
    return;
  }
  res.json(await resetOrganizationTestData(id, req.user!.id));
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

  res.json({
    relayEntryIp: settings.relay_entry_ip,
    relayExitIp: settings.relay_exit_ip,
    printerIp: settings.printer_ip,
    cameraBrand: settings.camera_brand,
    webhookToken: settings.webhook_token,
    webhookEntryUrl: buildWebhookUrl(settings.camera_brand, settings.webhook_token, "entry"),
    webhookExitUrl: buildWebhookUrl(settings.camera_brand, settings.webhook_token, "exit"),
    webhookDebugEntryUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, settings.webhook_token, "entry"),
    webhookDebugExitUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, settings.webhook_token, "exit"),
    lastWebhookEntryAt: settings.last_webhook_entry_at,
    lastWebhookExitAt: settings.last_webhook_exit_at,
    gateLayout: settings.gate_layout,
    crossCameraGuardSeconds: settings.cross_camera_guard_seconds,
  });
}

export async function updateIntegrationSettingsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const {
    relay_entry_ip,
    relay_exit_ip,
    printer_ip,
    camera_brand,
    gate_layout,
    cross_camera_guard_seconds,
  } = req.body ?? {};

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
  if (gate_layout !== undefined && gate_layout !== "shared" && gate_layout !== "separate") {
    res.status(400).json({ message: "gate_layout 'shared' yoki 'separate' bo'lishi kerak" });
    return;
  }
  if (
    cross_camera_guard_seconds !== undefined &&
    (!Number.isInteger(cross_camera_guard_seconds) ||
      cross_camera_guard_seconds < 5 ||
      cross_camera_guard_seconds > 300)
  ) {
    res.status(400).json({ message: "cross_camera_guard_seconds 5-300 oralig'ida bo'lishi kerak" });
    return;
  }

  const previousSettings = await organizationsService.getIntegrationSettings(id);
  const settings = await organizationsService.updateIntegrationSettings(id, {
    relay_entry_ip: relay_entry_ip === "" ? null : relay_entry_ip,
    relay_exit_ip: relay_exit_ip === "" ? null : relay_exit_ip,
    printer_ip: printer_ip === "" ? null : printer_ip,
    camera_brand: camera_brand === "" ? null : camera_brand,
    gate_layout,
    cross_camera_guard_seconds,
  });

  await logActivity(req.user!.id, "organization.integration_settings_updated", "organization", id, {
    relay_entry_ip: settings.relay_entry_ip,
    relay_exit_ip: settings.relay_exit_ip,
    printer_ip: settings.printer_ip,
    camera_brand: settings.camera_brand,
    gate_layout: settings.gate_layout,
    cross_camera_guard_seconds: settings.cross_camera_guard_seconds,
  });
  if (
    previousSettings.gate_layout !== settings.gate_layout ||
    previousSettings.cross_camera_guard_seconds !== settings.cross_camera_guard_seconds
  ) {
    await logActivity(req.user!.id, "organization.gate_layout_updated", "organization", id, {
      organization_id: id,
      changed_by_user_id: req.user!.id,
      previous: {
        gate_layout: previousSettings.gate_layout,
        cross_camera_guard_seconds: previousSettings.cross_camera_guard_seconds,
      },
      next: {
        gate_layout: settings.gate_layout,
        cross_camera_guard_seconds: settings.cross_camera_guard_seconds,
      },
      changed_at: new Date().toISOString(),
    });
  }

  res.json({
    relayEntryIp: settings.relay_entry_ip,
    relayExitIp: settings.relay_exit_ip,
    printerIp: settings.printer_ip,
    cameraBrand: settings.camera_brand,
    webhookToken: settings.webhook_token,
    webhookEntryUrl: buildWebhookUrl(settings.camera_brand, settings.webhook_token, "entry"),
    webhookExitUrl: buildWebhookUrl(settings.camera_brand, settings.webhook_token, "exit"),
    webhookDebugEntryUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, settings.webhook_token, "entry"),
    webhookDebugExitUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, settings.webhook_token, "exit"),
    gateLayout: settings.gate_layout,
    crossCameraGuardSeconds: settings.cross_camera_guard_seconds,
  });
}

export async function regenerateWebhookTokenHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null) return;

  const webhookToken = await organizationsService.regenerateWebhookToken(id);
  const settings = await organizationsService.getIntegrationSettings(id);

  await logActivity(req.user!.id, "organization.webhook_token_regenerated", "organization", id);

  res.json({
    webhookToken,
    webhookEntryUrl: buildWebhookUrl(settings.camera_brand, webhookToken, "entry"),
    webhookExitUrl: buildWebhookUrl(settings.camera_brand, webhookToken, "exit"),
    webhookDebugEntryUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, webhookToken, "entry"),
    webhookDebugExitUrl: buildWebhookUrl(DEBUG_CAMERA_BRAND, webhookToken, "exit"),
  });
}

function assertCameraRelayScope(req: Request, id: number, res: Response): boolean {
  if (req.user?.role === "owner" && req.user.org_id !== id) {
    res.status(404).json({ message: "Stoyanka topilmadi" });
    return false;
  }
  return true;
}

function parseRelayDirection(value: unknown, field: string, res: Response) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    res.status(400).json({ message: `${field} obyekt bo'lishi kerak` });
    return null;
  }
  const data = value as Record<string, unknown>;
  const host = data.host === "" ? null : data.host;
  const username = data.username === "" ? null : data.username;
  const password = data.password === "" ? null : data.password;
  if (host !== undefined && host !== null && (typeof host !== "string" || /[\s/?#]/.test(host) || host.includes("://"))) {
    res.status(400).json({ message: `${field}.host noto'g'ri` });
    return null;
  }
  if (username !== undefined && username !== null && typeof username !== "string") {
    res.status(400).json({ message: `${field}.username noto'g'ri` });
    return null;
  }
  if (password !== undefined && password !== null && typeof password !== "string") {
    res.status(400).json({ message: `${field}.password noto'g'ri` });
    return null;
  }
  if (data.port !== undefined && data.port !== null && (!Number.isInteger(data.port) || Number(data.port) < 1 || Number(data.port) > 65535)) {
    res.status(400).json({ message: `${field}.port 1-65535 oralig'ida bo'lishi kerak` });
    return null;
  }
  if (data.channel !== undefined && data.channel !== null && (!Number.isInteger(data.channel) || Number(data.channel) < 1)) {
    res.status(400).json({ message: `${field}.channel musbat butun son bo'lishi kerak` });
    return null;
  }
  return {
    host: host as string | null | undefined,
    port: data.port as number | null | undefined,
    username: username as string | null | undefined,
    password: password as string | null | undefined,
    channel: data.channel as number | null | undefined,
  };
}

export async function getCameraRelaySettingsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null || !assertCameraRelayScope(req, id, res)) return;
  res.json(await organizationsService.getCameraRelaySettings(id));
}

export async function updateCameraRelaySettingsHandler(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id === null || !assertCameraRelayScope(req, id, res)) return;
  const entry = parseRelayDirection(req.body?.entry, "entry", res);
  if (entry === null) return;
  const exit = parseRelayDirection(req.body?.exit, "exit", res);
  if (exit === null) return;
  if (!entry && !exit) {
    res.status(400).json({ message: "entry yoki exit sozlamasi yuborilishi kerak" });
    return;
  }
  const settings = await organizationsService.updateCameraRelaySettings(id, { entry, exit });
  await logActivity(req.user!.id, "organization.camera_relay_settings_updated", "organization", id, {
    entry: settings.entry,
    exit: settings.exit,
  });
  res.json(settings);
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
