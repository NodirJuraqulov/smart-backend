import { DateTime } from "luxon";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { LedClientError, LedDestination, sendPackets } from "./led.client";
import { buildLogicalPayload, buildPackets } from "./led.packetBuilder";
import { pixelsToPlane1, renderClock, renderPayment, renderPlateOnly } from "./led.renderer";

export type LedState = "clock" | "payment";

export interface LedConfiguration extends LedDestination {
  orgId: number;
}

type LedConfigurationLoader = (orgId: number) => Promise<LedConfiguration | null>;
type LedConfigurationListLoader = () => Promise<LedConfiguration[]>;

interface LedSettingsRow {
  id: number;
  led_host: string | null;
  led_port: number | null;
}

interface LedRuntime {
  state: LedState;
  modeGeneration: number;
  returnToClockTimer: NodeJS.Timeout | null;
  sendQueue: Promise<void>;
  lastClockRequestAtMs: number | null;
  lastClockRequestGeneration: number | null;
}

function toLedConfiguration(row: LedSettingsRow): LedConfiguration | null {
  const host = row.led_host?.trim();
  if (!host) return null;
  const configuredPort = Number(row.led_port);
  const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
    ? configuredPort
    : 10000;
  return { orgId: row.id, host, port };
}

async function loadLedConfiguration(orgId: number): Promise<LedConfiguration | null> {
  const row = await db<LedSettingsRow>("tb_organizations")
    .select("id", "led_host", "led_port")
    .where({ id: orgId })
    .first();
  return row ? toLedConfiguration(row) : null;
}

async function loadLedConfigurations(): Promise<LedConfiguration[]> {
  const rows = await db<LedSettingsRow>("tb_organizations")
    .select("id", "led_host", "led_port")
    .whereNotNull("led_host");
  return rows.flatMap((row) => {
    const configuration = toLedConfiguration(row);
    return configuration ? [configuration] : [];
  });
}

function createRuntime(): LedRuntime {
  return {
    state: "clock",
    modeGeneration: 0,
    returnToClockTimer: null,
    sendQueue: Promise.resolve(),
    lastClockRequestAtMs: null,
    lastClockRequestGeneration: null,
  };
}

export class LedService {
  private readonly runtimes = new Map<number, LedRuntime>();
  private clockTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getConfiguration: LedConfigurationLoader = loadLedConfiguration,
    private readonly listConfigurations: LedConfigurationListLoader = loadLedConfigurations
  ) {}

  private getRuntime(orgId: number): LedRuntime {
    const existing = this.runtimes.get(orgId);
    if (existing) return existing;
    const runtime = createRuntime();
    this.runtimes.set(orgId, runtime);
    return runtime;
  }

  private logError(error: unknown): void {
    const code = error instanceof LedClientError ? error.code : "LED_SEND_FAILED";
    console.error(code, error);
  }

  private clearReturnToClockTimer(runtime: LedRuntime): void {
    if (!runtime.returnToClockTimer) return;
    clearTimeout(runtime.returnToClockTimer);
    runtime.returnToClockTimer = null;
  }

  private send(
    runtime: LedRuntime,
    destination: LedDestination,
    plane1: Buffer,
    canSend: () => boolean = () => true
  ): Promise<boolean> {
    const packets = buildPackets(buildLogicalPayload(plane1));
    const operation = runtime.sendQueue.then(async () => {
      if (!canSend()) return false;
      await sendPackets(packets, { host: destination.host, port: destination.port });
      return true;
    });
    runtime.sendQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private isCurrentClockGeneration(runtime: LedRuntime, generation: number): boolean {
    return runtime.state === "clock" && runtime.modeGeneration === generation;
  }

  private isCurrentPaymentGeneration(runtime: LedRuntime, generation: number): boolean {
    return runtime.state === "payment" && runtime.modeGeneration === generation;
  }

  private async sendClock(
    orgId: number,
    runtime: LedRuntime,
    generation: number,
    knownConfiguration?: LedConfiguration
  ): Promise<boolean> {
    if (!this.isCurrentClockGeneration(runtime, generation)) return false;
    const requestedAtMs = Date.now();
    if (
      runtime.lastClockRequestGeneration === generation &&
      runtime.lastClockRequestAtMs !== null &&
      requestedAtMs - runtime.lastClockRequestAtMs < 1000
    ) return false;
    runtime.lastClockRequestAtMs = requestedAtMs;
    runtime.lastClockRequestGeneration = generation;
    try {
      const configuration = knownConfiguration ?? await this.getConfiguration(orgId);
      if (!configuration || !this.isCurrentClockGeneration(runtime, generation)) return false;
      const time = DateTime.now().setZone(env.platformDefaultTimezone).toFormat("HH:mm");
      const pixels = renderClock(time);
      const plane1 = pixelsToPlane1(pixels);
      const sent = await this.send(
        runtime,
        configuration,
        plane1,
        () => this.isCurrentClockGeneration(runtime, generation)
      );
      if (sent) console.log(`LED_CLOCK_SENT time=${time}`);
      return sent;
    } catch (error) {
      this.logError(error);
      return false;
    }
  }

  private async enterClockMode(
    orgId: number,
    runtime: LedRuntime,
    knownConfiguration?: LedConfiguration
  ): Promise<void> {
    this.clearReturnToClockTimer(runtime);
    runtime.modeGeneration += 1;
    const generation = runtime.modeGeneration;
    runtime.state = "clock";
    await this.sendClock(orgId, runtime, generation, knownConfiguration);
  }

  private enterPaymentMode(runtime: LedRuntime): number {
    this.clearReturnToClockTimer(runtime);
    runtime.modeGeneration += 1;
    runtime.state = "payment";
    return runtime.modeGeneration;
  }

  private discardUnconfiguredPayment(runtime: LedRuntime, generation: number): void {
    if (!this.isCurrentPaymentGeneration(runtime, generation)) return;
    this.clearReturnToClockTimer(runtime);
    runtime.modeGeneration += 1;
    runtime.state = "clock";
  }

  async showClock(orgId: number): Promise<void> {
    if (!env.led.enabled) return;
    try {
      const configuration = await this.getConfiguration(orgId);
      if (!configuration) return;
      await this.enterClockMode(orgId, this.getRuntime(orgId), configuration);
    } catch (error) {
      this.logError(error);
    }
  }

  async showPayment(orgId: number, plate: string, amount: number): Promise<void> {
    if (!env.led.enabled) return;
    const runtime = this.getRuntime(orgId);
    const generation = this.enterPaymentMode(runtime);
    let configuration: LedConfiguration | null;
    try {
      configuration = await this.getConfiguration(orgId);
    } catch (error) {
      this.discardUnconfiguredPayment(runtime, generation);
      this.logError(error);
      return;
    }
    if (!configuration) {
      this.discardUnconfiguredPayment(runtime, generation);
      return;
    }
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const normalizedAmount = String(amount).replace(/\D/g, "");
      const pixels = renderPayment(normalizedPlate, normalizedAmount);
      const plane1 = pixelsToPlane1(pixels);
      const sent = await this.send(
        runtime,
        configuration,
        plane1,
        () => this.isCurrentPaymentGeneration(runtime, generation)
      );
      if (sent) console.log(`LED_PAYMENT_SENT plate=${normalizedPlate} amount=${normalizedAmount}`);
    } catch (error) {
      this.logError(error);
    }
  }

  async showPlateOnly(orgId: number, plate: string): Promise<void> {
    if (!env.led.enabled) return;
    const runtime = this.getRuntime(orgId);
    const generation = this.enterPaymentMode(runtime);
    let configuration: LedConfiguration | null;
    try {
      configuration = await this.getConfiguration(orgId);
    } catch (error) {
      this.discardUnconfiguredPayment(runtime, generation);
      this.logError(error);
      return;
    }
    if (!configuration) {
      this.discardUnconfiguredPayment(runtime, generation);
      return;
    }
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const pixels = renderPlateOnly(normalizedPlate);
      const plane1 = pixelsToPlane1(pixels);
      const sent = await this.send(
        runtime,
        configuration,
        plane1,
        () => this.isCurrentPaymentGeneration(runtime, generation)
      );
      if (sent) console.log(`LED_PLATE_SENT plate=${normalizedPlate}`);
    } catch (error) {
      this.logError(error);
    }
  }

  scheduleReturnToClock(orgId: number): void {
    if (!env.led.enabled) return;
    const runtime = this.runtimes.get(orgId);
    if (!runtime) return;
    try {
      this.clearReturnToClockTimer(runtime);
      const generation = runtime.modeGeneration;
      runtime.returnToClockTimer = setTimeout(() => {
        runtime.returnToClockTimer = null;
        const current = runtime.state === "payment" && runtime.modeGeneration === generation;
        if (!current) return;
        try {
          void this.enterClockMode(orgId, runtime).catch((error) => {
            this.logError(error);
          });
        } catch (error) {
          this.logError(error);
        }
      }, env.led.paymentConfirmDelayMs);
      runtime.returnToClockTimer.unref();
    } catch (error) {
      this.logError(error);
    }
  }

  private async runClockSchedulerTick(): Promise<void> {
    let configurations: LedConfiguration[];
    try {
      configurations = await this.listConfigurations();
    } catch (error) {
      this.logError(error);
      return;
    }
    await Promise.all(
      configurations.map(async (configuration) => {
        const runtime = this.getRuntime(configuration.orgId);
        if (runtime.state !== "clock") return;
        const generation = runtime.modeGeneration;
        await this.sendClock(configuration.orgId, runtime, generation, configuration);
      })
    );
  }

  private scheduleNextClockTick(): void {
    const intervalMs = env.led.clockIntervalMs;
    const remainderMs = Date.now() % intervalMs;
    const delayMs = remainderMs === 0 ? intervalMs : intervalMs - remainderMs;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = null;
      try {
        void this.runClockSchedulerTick().catch((error) => {
          this.logError(error);
        });
        this.scheduleNextClockTick();
      } catch (error) {
        this.logError(error);
      }
    }, delayMs);
    this.clockTimer.unref();
  }

  async showClockForConfiguredOrganizations(): Promise<void> {
    if (!env.led.enabled) return;
    try {
      const configurations = await this.listConfigurations();
      await Promise.all(
        configurations.map((configuration) =>
          this.enterClockMode(configuration.orgId, this.getRuntime(configuration.orgId), configuration)
        )
      );
    } catch (error) {
      this.logError(error);
    }
  }

  startClockScheduler(): void {
    if (!env.led.enabled || this.clockTimer) return;
    try {
      this.scheduleNextClockTick();
    } catch (error) {
      this.logError(error);
    }
  }
}

export const ledService = new LedService();
