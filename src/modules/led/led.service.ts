import { DateTime } from "luxon";
import { env } from "@/config/env";
import { LedClientError, sendPackets } from "./led.client";
import { buildLogicalPayload, buildPackets } from "./led.packetBuilder";
import { pixelsToPlane1, renderClock, renderPayment, renderPlateOnly } from "./led.renderer";

export type LedState = "clock" | "payment";

export class LedService {
  private state: LedState = "clock";
  private modeGeneration = 0;
  private returnToClockTimer: NodeJS.Timeout | null = null;
  private clockTimer: NodeJS.Timeout | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private lastClockRequestAtMs: number | null = null;
  private lastClockRequestGeneration: number | null = null;

  private logError(error: unknown): void {
    const code = error instanceof LedClientError ? error.code : "LED_SEND_FAILED";
    console.error(code, error);
  }

  private clearReturnToClockTimer(): void {
    if (!this.returnToClockTimer) return;
    clearTimeout(this.returnToClockTimer);
    this.returnToClockTimer = null;
  }

  private send(plane1: Buffer, canSend: () => boolean = () => true): Promise<boolean> {
    const packets = buildPackets(buildLogicalPayload(plane1));
    const operation = this.sendQueue.then(async () => {
      if (!canSend()) return false;
      await sendPackets(packets);
      return true;
    });
    this.sendQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private isCurrentClockGeneration(generation: number): boolean {
    return this.state === "clock" && this.modeGeneration === generation;
  }

  private isCurrentPaymentGeneration(generation: number): boolean {
    return this.state === "payment" && this.modeGeneration === generation;
  }

  private async sendClock(generation: number): Promise<boolean> {
    if (!this.isCurrentClockGeneration(generation)) return false;
    const requestedAtMs = Date.now();
    if (
      this.lastClockRequestGeneration === generation &&
      this.lastClockRequestAtMs !== null &&
      requestedAtMs - this.lastClockRequestAtMs < 1000
    ) return false;
    this.lastClockRequestAtMs = requestedAtMs;
    this.lastClockRequestGeneration = generation;
    try {
      const time = DateTime.now().setZone(env.platformDefaultTimezone).toFormat("HH:mm");
      const pixels = renderClock(time);
      const plane1 = pixelsToPlane1(pixels);
      return await this.send(plane1, () => this.isCurrentClockGeneration(generation));
    } catch (error) {
      this.logError(error);
      return false;
    }
  }

  private async enterClockMode(): Promise<void> {
    this.clearReturnToClockTimer();
    this.modeGeneration += 1;
    const generation = this.modeGeneration;
    this.state = "clock";
    await this.sendClock(generation);
  }

  private enterPaymentMode(): number {
    this.clearReturnToClockTimer();
    this.modeGeneration += 1;
    this.state = "payment";
    return this.modeGeneration;
  }

  async showClock(): Promise<void> {
    if (!env.led.enabled) return;
    await this.enterClockMode();
  }

  async showPayment(plate: string, amount: number): Promise<void> {
    if (!env.led.enabled) return;
    const generation = this.enterPaymentMode();
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const normalizedAmount = String(amount).replace(/\D/g, "");
      const pixels = renderPayment(normalizedPlate, normalizedAmount);
      const plane1 = pixelsToPlane1(pixels);
      await this.send(plane1, () => this.isCurrentPaymentGeneration(generation));
    } catch (error) {
      this.logError(error);
    }
  }

  async showPlateOnly(plate: string): Promise<void> {
    if (!env.led.enabled) return;
    const generation = this.enterPaymentMode();
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const pixels = renderPlateOnly(normalizedPlate);
      const plane1 = pixelsToPlane1(pixels);
      await this.send(plane1, () => this.isCurrentPaymentGeneration(generation));
    } catch (error) {
      this.logError(error);
    }
  }

  scheduleReturnToClock(): void {
    if (!env.led.enabled) return;
    try {
      this.clearReturnToClockTimer();
      const generation = this.modeGeneration;
      this.returnToClockTimer = setTimeout(() => {
        this.returnToClockTimer = null;
        const current = this.state === "payment" && this.modeGeneration === generation;
        if (!current) return;
        try {
          void this.enterClockMode().catch((error) => {
            this.logError(error);
          });
        } catch (error) {
          this.logError(error);
        }
      }, env.led.paymentConfirmDelayMs);
      this.returnToClockTimer.unref();
    } catch (error) {
      this.logError(error);
    }
  }

  private runClockSchedulerTick(): void {
    if (this.state !== "clock") return;
    const generation = this.modeGeneration;
    try {
      void this.sendClock(generation).catch((error) => {
        this.logError(error);
      });
    } catch (error) {
      this.logError(error);
    }
  }

  private scheduleNextClockTick(): void {
    const intervalMs = env.led.clockIntervalMs;
    const remainderMs = Date.now() % intervalMs;
    const delayMs = remainderMs === 0 ? intervalMs : intervalMs - remainderMs;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = null;
      try {
        this.runClockSchedulerTick();
        this.scheduleNextClockTick();
      } catch (error) {
        this.logError(error);
      }
    }, delayMs);
    this.clockTimer.unref();
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
