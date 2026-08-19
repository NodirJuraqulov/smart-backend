import { DateTime } from "luxon";
import { env } from "@/config/env";
import { LedClientError, sendPackets } from "./led.client";
import { buildLogicalPayload, buildPackets } from "./led.packetBuilder";
import { pixelsToPlane1, renderClock, renderPayment } from "./led.renderer";

export type LedState = "clock" | "payment";

export class LedService {
  private state: LedState = "clock";
  private returnToClockTimer: NodeJS.Timeout | null = null;
  private clockTimer: NodeJS.Timeout | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  private logError(error: unknown): void {
    const code = error instanceof LedClientError ? error.code : "LED_SEND_FAILED";
    console.error(code, error);
  }

  private clearReturnToClockTimer(): void {
    if (!this.returnToClockTimer) return;
    clearTimeout(this.returnToClockTimer);
    this.returnToClockTimer = null;
  }

  private send(plane1: Buffer): Promise<void> {
    const packets = buildPackets(buildLogicalPayload(plane1));
    const operation = this.sendQueue.then(() => sendPackets(packets));
    this.sendQueue = operation.catch(() => undefined);
    return operation;
  }

  async showClock(): Promise<void> {
    if (!env.led.enabled) return;
    this.state = "clock";
    try {
      const time = DateTime.now().setZone(env.platformDefaultTimezone).toFormat("HH:mm");
      const plane1 = pixelsToPlane1(renderClock(time));
      await this.send(plane1);
    } catch (error) {
      this.logError(error);
    }
  }

  async showPayment(plate: string, amount: number): Promise<void> {
    if (!env.led.enabled) return;
    this.clearReturnToClockTimer();
    this.state = "payment";
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const normalizedAmount = String(amount).replace(/\D/g, "");
      const plane1 = pixelsToPlane1(renderPayment(normalizedPlate, normalizedAmount));
      await this.send(plane1);
    } catch (error) {
      this.logError(error);
    }
  }

  scheduleReturnToClock(): void {
    if (!env.led.enabled) return;
    try {
      this.clearReturnToClockTimer();
      this.returnToClockTimer = setTimeout(() => {
        this.returnToClockTimer = null;
        try {
          void this.showClock();
        } catch (error) {
          this.logError(error);
        }
      }, env.led.paymentConfirmDelayMs);
      this.returnToClockTimer.unref();
    } catch (error) {
      this.logError(error);
    }
  }

  startClockScheduler(): void {
    if (!env.led.enabled || this.clockTimer) return;
    try {
      this.clockTimer = setInterval(() => {
        if (this.state !== "clock") return;
        try {
          void this.showClock();
        } catch (error) {
          this.logError(error);
        }
      }, env.led.clockIntervalMs);
      this.clockTimer.unref();
    } catch (error) {
      this.logError(error);
    }
  }
}

export const ledService = new LedService();
