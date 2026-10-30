import { afterEach, describe, expect, it, vi } from "vitest";
import { collectProductionSafetyErrors, stripTrailingSlashes } from "@/config/env";

const exitControlEnvNames = [
  "EXIT_MATCH_V2_ENABLED",
  "FREE_EXIT_RECOVERY_ENABLED",
  "FREE_EXIT_RECOVERY_HOURS",
  "CANCELLED_EXIT_COOLDOWN_SECONDS",
  "FORCED_OPEN_RETENTION_DAYS",
  "FORCED_OPEN_AVG_LOSS_SOM",
  "STALE_SESSION_CLEANUP_ENABLED",
  "STALE_SESSION_CLEANUP_KEEP_DAYS",
  "STALE_SESSION_CLEANUP_MAX_PER_RUN",
  "STALE_SESSION_CLEANUP_CRON",
  "WEBHOOK_IMAGES_CLEANUP_ENABLED",
  "WEBHOOK_IMAGES_RETENTION_DAYS",
  "WEBHOOK_IMAGES_CLEANUP_MAX_PER_RUN",
  "WEBHOOK_IMAGES_CLEANUP_CRON",
] as const;

async function loadExitControlEnv(overrides: Partial<Record<(typeof exitControlEnvNames)[number], string>>) {
  for (const name of exitControlEnvNames) {
    vi.stubEnv(name, overrides[name] ?? "");
  }
  vi.resetModules();
  return (await import("@/config/env")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const validConfig = {
  jwtSecret: "a".repeat(40),
  corsOrigin: "https://app.stoyanka.uz",
  dbPassword: "Kuchli-Tasodifiy-Parol-2026",
  publicBaseUrl: "http://195.158.9.168:84",
  encryptionKey: "a".repeat(64),
};

describe("stripTrailingSlashes", () => {
  it("bitta oxirgi / ni olib tashlaydi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84/")).toBe("http://195.158.9.168:84");
  });

  it("bir nechta ketma-ket / larni ham olib tashlaydi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84///")).toBe("http://195.158.9.168:84");
  });

  it("/ bo'lmasa o'zgarishsiz qoldiradi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84")).toBe("http://195.158.9.168:84");
  });
});

describe("collectProductionSafetyErrors — PUBLIC_BASE_URL", () => {
  it("to'g'ri konfiguratsiyada xato qaytarmaydi", () => {
    expect(collectProductionSafetyErrors(validConfig)).toEqual([]);
  });

  it("PUBLIC_BASE_URL belgilanmagan bo'lsa — tushunarli xato qaytaradi", () => {
    const errors = collectProductionSafetyErrors({ ...validConfig, publicBaseUrl: undefined });
    expect(errors).toContain(
      "PUBLIC_BASE_URL belgilanmagan — webhook URL generatsiyasi uchun majburiy (masalan http://195.158.9.168:84)"
    );
  });

  it("PUBLIC_BASE_URL noto'g'ri formatda bo'lsa — tushunarli xato qaytaradi", () => {
    const errors = collectProductionSafetyErrors({ ...validConfig, publicBaseUrl: "not-a-valid-url" });
    expect(errors).toContain(`PUBLIC_BASE_URL noto'g'ri URL formatida: "not-a-valid-url"`);
  });

  it("boshqa xatolar bilan bir qatorda mustaqil qayd etiladi", () => {
    const errors = collectProductionSafetyErrors({
      jwtSecret: "short",
      corsOrigin: "*",
      dbPassword: "",
      publicBaseUrl: undefined,
      encryptionKey: "",
    });
    expect(errors).toHaveLength(5);
  });
});

describe("exit control env", () => {
  it("qiymatlar berilmaganda xavfsiz defaultlarni ishlatadi", async () => {
    const configuredEnv = await loadExitControlEnv({});

    expect(configuredEnv.exitMatchV2Enabled).toBe(false);
    expect(configuredEnv.freeExitRecovery).toEqual({ enabled: false, hours: 6 });
    expect(configuredEnv.cancelledExitCooldownSeconds).toBe(60);
    expect(configuredEnv.forcedOpenRetentionDays).toBe(4);
    expect(configuredEnv.forcedOpenAvgLossSom).toBe(10000);
    expect(configuredEnv.staleSessionCleanup).toEqual({
      enabled: false,
      keepDays: 2,
      maxPerRun: 1000,
      cron: "30 3 * * *",
    });
    expect(configuredEnv.webhookImagesCleanup).toEqual({
      enabled: false,
      retentionDays: 30,
      maxPerRun: 20000,
      cron: "30 4 * * *",
    });
  });

  it("literal true va musbat configured qiymatlarni qabul qiladi", async () => {
    const configuredEnv = await loadExitControlEnv({
      EXIT_MATCH_V2_ENABLED: "true",
      FREE_EXIT_RECOVERY_ENABLED: "true",
      FREE_EXIT_RECOVERY_HOURS: "12",
      CANCELLED_EXIT_COOLDOWN_SECONDS: "90",
      FORCED_OPEN_RETENTION_DAYS: "8",
      FORCED_OPEN_AVG_LOSS_SOM: "25000",
      STALE_SESSION_CLEANUP_ENABLED: "true",
      STALE_SESSION_CLEANUP_KEEP_DAYS: "4",
      STALE_SESSION_CLEANUP_MAX_PER_RUN: "300",
      STALE_SESSION_CLEANUP_CRON: "15 2 * * *",
      WEBHOOK_IMAGES_CLEANUP_ENABLED: "true",
      WEBHOOK_IMAGES_RETENTION_DAYS: "45",
      WEBHOOK_IMAGES_CLEANUP_MAX_PER_RUN: "500",
      WEBHOOK_IMAGES_CLEANUP_CRON: "20 4 * * *",
    });

    expect(configuredEnv.exitMatchV2Enabled).toBe(true);
    expect(configuredEnv.freeExitRecovery).toEqual({ enabled: true, hours: 12 });
    expect(configuredEnv.cancelledExitCooldownSeconds).toBe(90);
    expect(configuredEnv.forcedOpenRetentionDays).toBe(8);
    expect(configuredEnv.forcedOpenAvgLossSom).toBe(25000);
    expect(configuredEnv.staleSessionCleanup).toEqual({
      enabled: true,
      keepDays: 4,
      maxPerRun: 300,
      cron: "15 2 * * *",
    });
    expect(configuredEnv.webhookImagesCleanup).toEqual({
      enabled: true,
      retentionDays: 45,
      maxPerRun: 500,
      cron: "20 4 * * *",
    });
  });

  it("noto'g'ri numeric qiymatlarni defaultga qaytaradi", async () => {
    const configuredEnv = await loadExitControlEnv({
      FORCED_OPEN_AVG_LOSS_SOM: "NaN",
      FREE_EXIT_RECOVERY_HOURS: "0",
      CANCELLED_EXIT_COOLDOWN_SECONDS: "0",
      FORCED_OPEN_RETENTION_DAYS: "0",
      STALE_SESSION_CLEANUP_KEEP_DAYS: "0",
      STALE_SESSION_CLEANUP_MAX_PER_RUN: "-5",
      WEBHOOK_IMAGES_RETENTION_DAYS: "0",
      WEBHOOK_IMAGES_CLEANUP_MAX_PER_RUN: "-5",
    });

    expect(configuredEnv.forcedOpenAvgLossSom).toBe(10000);
    expect(configuredEnv.freeExitRecovery.hours).toBe(6);
    expect(configuredEnv.cancelledExitCooldownSeconds).toBe(60);
    expect(configuredEnv.forcedOpenRetentionDays).toBe(4);
    expect(configuredEnv.staleSessionCleanup.keepDays).toBe(2);
    expect(configuredEnv.staleSessionCleanup.maxPerRun).toBe(1000);
    expect(configuredEnv.webhookImagesCleanup.retentionDays).toBe(30);
    expect(configuredEnv.webhookImagesCleanup.maxPerRun).toBe(20000);
  });
});
