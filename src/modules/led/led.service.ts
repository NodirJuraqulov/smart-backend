import { DateTime } from "luxon";
import { env } from "@/config/env";
import { LedClientError, sendPackets } from "./led.client";
import { buildLogicalPayload, buildPackets } from "./led.packetBuilder";
import { pixelsToPlane1, renderClock, renderPayment } from "./led.renderer";
import {
  createLedDiagnosticTrace,
  LedDiagnosticTrace,
  logLedDiagnostic,
} from "./led.diagnostics";

export type LedState = "clock" | "payment";

export class LedService {
  private state: LedState = "clock";
  private returnToClockTimer: NodeJS.Timeout | null = null;
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
    this.returnToClockTimer = null;
  }

  private send(plane1: Buffer, trace: LedDiagnosticTrace): Promise<void> {
    const packets = buildPackets(buildLogicalPayload(plane1));
    this.pendingSendCount += 1;
    const queuedAtMs = logLedDiagnostic("LED_DIAG_SEND_QUEUE_ENQUEUED", trace, {
      queueDepth: this.pendingSendCount,
      packetCount: packets.length,
    });
    const operation = this.sendQueue.then(() => {
      logLedDiagnostic("LED_DIAG_SEND_QUEUE_STARTED", trace, {
        queueDepth: this.pendingSendCount,
        queueWaitMs: Date.now() - queuedAtMs,
        packetCount: packets.length,
      });
      return sendPackets(packets, trace);
    });
    this.sendQueue = operation.catch(() => undefined);
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

  async showClock(
    trace: LedDiagnosticTrace = createLedDiagnosticTrace("clock", { trigger: "direct" })
  ): Promise<void> {
    logLedDiagnostic("LED_DIAG_CLOCK_SHOW_FIRST_LINE", trace, {
      state: this.state,
      enabled: env.led.enabled,
    });
    if (!env.led.enabled) return;
    this.state = "clock";
    try {
      const time = DateTime.now().setZone(env.platformDefaultTimezone).toFormat("HH:mm");
      const renderStartedAtMs = logLedDiagnostic("LED_DIAG_CLOCK_RENDER_START", trace, { time });
      const pixels = renderClock(time);
      logLedDiagnostic("LED_DIAG_CLOCK_RENDER_END", trace, {
        time,
        renderElapsedMs: Date.now() - renderStartedAtMs,
      });
      const plane1 = pixelsToPlane1(pixels);
      await this.send(plane1, trace);
      logLedDiagnostic("LED_DIAG_CLOCK_OPERATION_FINISHED", trace, { time });
    } catch (error) {
      logLedDiagnostic("LED_DIAG_CLOCK_OPERATION_FAILED", trace, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.logError(error);
    }
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
    this.clearReturnToClockTimer();
    this.state = "payment";
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

  scheduleReturnToClock(): void {
    if (!env.led.enabled) return;
    try {
      this.clearReturnToClockTimer();
      const trace = createLedDiagnosticTrace("clock", { trigger: "payment-return-timer" });
      logLedDiagnostic("LED_DIAG_CLOCK_RETURN_TIMER_SCHEDULED", trace, {
        delayMs: env.led.paymentConfirmDelayMs,
        state: this.state,
      });
      this.returnToClockTimer = setTimeout(() => {
        this.returnToClockTimer = null;
        logLedDiagnostic("LED_DIAG_CLOCK_RETURN_TIMER_FIRED", trace, {
          delayMs: env.led.paymentConfirmDelayMs,
          state: this.state,
        });
        try {
          logLedDiagnostic("LED_DIAG_CLOCK_BEFORE_SHOW_CLOCK", trace, {
            trigger: "payment-return-timer",
          });
          void this.showClock(trace);
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
    logLedDiagnostic("LED_DIAG_CLOCK_SCHEDULER_FIRED", trace, {
      state: this.state,
      intervalMs: env.led.clockIntervalMs,
    });
    if (this.state !== "clock") {
      logLedDiagnostic("LED_DIAG_CLOCK_SCHEDULER_SKIPPED", trace, {
        state: this.state,
      });
      return;
    }
    try {
      logLedDiagnostic("LED_DIAG_CLOCK_BEFORE_SHOW_CLOCK", trace, {
        trigger: "scheduler",
      });
      void this.showClock(trace);
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
