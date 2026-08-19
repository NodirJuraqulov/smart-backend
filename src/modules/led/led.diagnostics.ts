import { env } from "@/config/env";

export interface LedDiagnosticTrace {
  traceId: string;
  kind: string;
  startedAtMs: number;
  metadata: Record<string, unknown>;
}

let traceSequence = 0;
const requestTraces = new WeakMap<object, LedDiagnosticTrace>();

export function createLedDiagnosticTrace(
  kind: string,
  metadata: Record<string, unknown> = {}
): LedDiagnosticTrace {
  const startedAtMs = Date.now();
  traceSequence += 1;
  return {
    traceId: `${kind}-${startedAtMs}-${traceSequence}`,
    kind,
    startedAtMs,
    metadata,
  };
}

export function logLedDiagnostic(
  marker: string,
  trace: LedDiagnosticTrace,
  details: Record<string, unknown> = {}
): number {
  const timestampMs = Date.now();
  if (env.led.enabled) {
    console.log(
      marker,
      JSON.stringify({
        ...trace.metadata,
        ...details,
        traceId: trace.traceId,
        kind: trace.kind,
        timestampMs,
        timestampIso: new Date(timestampMs).toISOString(),
        elapsedMs: timestampMs - trace.startedAtMs,
      })
    );
  }
  return timestampMs;
}

export function ensureExitWebhookDiagnosticTrace(
  request: object,
  metadata: Record<string, unknown> = {}
): LedDiagnosticTrace {
  const existing = requestTraces.get(request);
  if (existing) return existing;
  const trace = createLedDiagnosticTrace("exit-webhook", metadata);
  requestTraces.set(request, trace);
  logLedDiagnostic("LED_DIAG_EXIT_WEBHOOK_RECEIVED", trace);
  return trace;
}
