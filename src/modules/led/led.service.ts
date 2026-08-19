import { DateTime } from "luxon";
import { env } from "@/config/env";
import { LedClientError, sendPackets } from "./led.client";
import { buildLogicalPayload, buildPackets } from "./led.packetBuilder";
import { pixelsToPlane1, renderClock, renderPayment, renderPlateOnly } from "./led.renderer";
import {
  createLedDiagnosticTrace,
  LedDiagnosticTrace,
  logLedDiagnostic,
} from "./led.diagnostics";

export type LedState = "clock" | "payment";

export class LedService {
  private state: LedState = "clock";
  private modeGeneration = 0;
  private returnToClockTimer: NodeJS.Timeout | null = null;
  private returnToClockTrace: LedDiagnosticTrace | null = null;
  private clockTimer: NodeJS.Timeout | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private pendingSendCount = 0;

  private logError(error: unknown): void {
    const code = error instanceof LedClientError ? error.code : "LED_SEND_FAILED";
    console.error(code, error);
  }

  private clearReturnToClockTimer(): void {
    if (!this.returnToClockTimer) return;
    clearTimeout(this.returnToClockTimer);
    if (this.returnToClockTrace) {
      logLedDiagnostic("RETURN_TO_CLOCK_TIMER_CANCELLED", this.returnToClockTrace, {
        state: this.state,
        generation: this.modeGeneration,
      });
    }
    this.returnToClockTimer = null;
    this.returnToClockTrace = null;
  }

  private send(
    plane1: Buffer,
    trace: LedDiagnosticTrace,
    canSend: () => boolean = () => true
  ): Promise<boolean> {
    const packets = buildPackets(buildLogicalPayload(plane1));
    this.pendingSendCount += 1;
    const queuedAtMs = logLedDiagnostic("LED_DIAG_SEND_QUEUE_ENQUEUED", trace, {
      queueDepth: this.pendingSendCount,
      packetCount: packets.length,
    });
    const operation = this.sendQueue.then(async () => {
      if (!canSend()) {
        logLedDiagnostic("CLOCK_STALE_SEND_SKIPPED", trace, {
          queueDepth: this.pendingSendCount,
          queueWaitMs: Date.now() - queuedAtMs,
        });
        return false;
      }
      logLedDiagnostic("LED_DIAG_SEND_QUEUE_STARTED", trace, {
        queueDepth: this.pendingSendCount,
        queueWaitMs: Date.now() - queuedAtMs,
        packetCount: packets.length,
      });
      await sendPackets(packets, trace);
      return true;
    });
    this.sendQueue = operation.then(
      () => undefined,
      () => undefined
    );
    operation.then(
      () => {
        this.pendingSendCount -= 1;
      },
      () => {
        this.pendingSendCount -= 1;
      }
    );
    return operation;
  }

  private isCurrentClockGeneration(generation: number): boolean {
    return this.state === "clock" && this.modeGeneration === generation;
  }

  private async sendClock(trace: LedDiagnosticTrace, generation: number): Promise<boolean> {
    if (!this.isCurrentClockGeneration(generation)) {
      logLedDiagnostic("CLOCK_STALE_SEND_SKIPPED", trace, {
        state: this.state,
        generation,
        currentGeneration: this.modeGeneration,
      });
      return false;
    }
    try {
      const time = DateTime.now().setZone(env.platformDefaultTimezone).toFormat("HH:mm");
      const renderStartedAtMs = logLedDiagnostic("LED_DIAG_CLOCK_RENDER_START", trace, { time });
      const pixels = renderClock(time);
      logLedDiagnostic("LED_DIAG_CLOCK_RENDER_END", trace, {
        time,
        renderElapsedMs: Date.now() - renderStartedAtMs,
      });
      const plane1 = pixelsToPlane1(pixels);
      const sent = await this.send(plane1, trace, () => this.isCurrentClockGeneration(generation));
      if (sent) {
        logLedDiagnostic("LED_DIAG_CLOCK_OPERATION_FINISHED", trace, { time });
      }
      return sent;
    } catch (error) {
      logLedDiagnostic("LED_DIAG_CLOCK_OPERATION_FAILED", trace, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.logError(error);
      return false;
    }
  }

  private async enterClockMode(trace: LedDiagnosticTrace, trigger: string): Promise<void> {
    this.clearReturnToClockTimer();
    this.modeGeneration += 1;
    const generation = this.modeGeneration;
    this.state = "clock";
    logLedDiagnostic("CLOCK_MODE_ENTERED", trace, { trigger, generation });
    logLedDiagnostic("CLOCK_IMMEDIATE_SHOW_START", trace, { trigger, generation });
    const sent = await this.sendClock(trace, generation);
    logLedDiagnostic("CLOCK_IMMEDIATE_SHOW_FINISHED", trace, {
      trigger,
      generation,
      sent,
      state: this.state,
    });
  }

  private enterPaymentMode(trace: LedDiagnosticTrace, details: Record<string, unknown>): void {
    this.clearReturnToClockTimer();
    this.modeGeneration += 1;
    this.state = "payment";
    logLedDiagnostic("PAYMENT_MODE_ENTERED", trace, {
      ...details,
      generation: this.modeGeneration,
    });
  }

  async showClock(
    trace: LedDiagnosticTrace = createLedDiagnosticTrace("clock", { trigger: "direct" })
  ): Promise<void> {
    logLedDiagnostic("LED_DIAG_CLOCK_SHOW_FIRST_LINE", trace, {
      state: this.state,
      enabled: env.led.enabled,
    });
    if (!env.led.enabled) return;
    await this.enterClockMode(trace, String(trace.metadata.trigger ?? "direct"));
  }

  async showPayment(
    plate: string,
    amount: number,
    trace: LedDiagnosticTrace = createLedDiagnosticTrace("payment", { trigger: "direct" })
  ): Promise<void> {
    logLedDiagnostic("LED_DIAG_PAYMENT_SHOW_FIRST_LINE", trace, {
      state: this.state,
      enabled: env.led.enabled,
      plateNumber: plate,
      amount,
    });
    if (!env.led.enabled) return;
    this.enterPaymentMode(trace, { plateNumber: plate, amount });
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const normalizedAmount = String(amount).replace(/\D/g, "");
      const renderStartedAtMs = logLedDiagnostic("LED_DIAG_PAYMENT_RENDER_START", trace, {
        plateNumber: normalizedPlate,
        amount: normalizedAmount,
      });
      const pixels = renderPayment(normalizedPlate, normalizedAmount);
      logLedDiagnostic("LED_DIAG_PAYMENT_RENDER_END", trace, {
        plateNumber: normalizedPlate,
        amount: normalizedAmount,
        renderElapsedMs: Date.now() - renderStartedAtMs,
      });
      const plane1 = pixelsToPlane1(pixels);
      await this.send(plane1, trace);
      logLedDiagnostic("LED_DIAG_PAYMENT_OPERATION_FINISHED", trace, {
        plateNumber: normalizedPlate,
        amount: normalizedAmount,
      });
    } catch (error) {
      logLedDiagnostic("LED_DIAG_PAYMENT_OPERATION_FAILED", trace, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.logError(error);
    }
  }

  async showPlateOnly(
    plate: string,
    trace: LedDiagnosticTrace = createLedDiagnosticTrace("plate", { trigger: "direct" })
  ): Promise<void> {
    logLedDiagnostic("LED_DIAG_PLATE_SHOW_FIRST_LINE", trace, {
      state: this.state,
      enabled: env.led.enabled,
      plateNumber: plate,
    });
    if (!env.led.enabled) return;
    this.enterPaymentMode(trace, { plateNumber: plate, displayType: "plate-only" });
    try {
      const normalizedPlate = plate.toUpperCase().replace(/\s/g, "").slice(0, 10);
      const renderStartedAtMs = logLedDiagnostic("LED_DIAG_PLATE_RENDER_START", trace, {
        plateNumber: normalizedPlate,
      });
      const pixels = renderPlateOnly(normalizedPlate);
      logLedDiagnostic("LED_DIAG_PLATE_RENDER_END", trace, {
        plateNumber: normalizedPlate,
        renderElapsedMs: Date.now() - renderStartedAtMs,
      });
      const plane1 = pixelsToPlane1(pixels);
      await this.send(plane1, trace);
      logLedDiagnostic("LED_DIAG_PLATE_OPERATION_FINISHED", trace, {
        plateNumber: normalizedPlate,
      });
    } catch (error) {
      logLedDiagnostic("LED_DIAG_PLATE_OPERATION_FAILED", trace, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.logError(error);
    }
  }

  scheduleReturnToClock(): void {
    if (!env.led.enabled) return;
    try {
      this.clearReturnToClockTimer();
      const trace = createLedDiagnosticTrace("clock", { trigger: "payment-return-timer" });
      const generation = this.modeGeneration;
      this.returnToClockTrace = trace;
      logLedDiagnostic("RETURN_TO_CLOCK_TIMER_STARTED", trace, {
        delayMs: env.led.paymentConfirmDelayMs,
        state: this.state,
        generation,
      });
      this.returnToClockTimer = setTimeout(() => {
        this.returnToClockTimer = null;
        this.returnToClockTrace = null;
        const current = this.state === "payment" && this.modeGeneration === generation;
        logLedDiagnostic("RETURN_TO_CLOCK_TIMER_FIRED", trace, {
          delayMs: env.led.paymentConfirmDelayMs,
          state: this.state,
          generation,
          currentGeneration: this.modeGeneration,
          current,
        });
        if (!current) return;
        try {
          void this.enterClockMode(trace, "payment-return-timer").catch((error) => {
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
    const trace = createLedDiagnosticTrace("clock", { trigger: "scheduler" });
    logLedDiagnostic("CLOCK_SCHEDULER_FIRED", trace, {
      state: this.state,
      intervalMs: env.led.clockIntervalMs,
      generation: this.modeGeneration,
    });
    if (this.state !== "clock") {
      logLedDiagnostic("CLOCK_SCHEDULER_SKIPPED", trace, {
        state: this.state,
      });
      return;
    }
    const generation = this.modeGeneration;
    try {
      void this.sendClock(trace, generation).catch((error) => {
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
