// Phase 01 platform boundary: observability seam (Datadog lands Phase 18+).
// The no-op default keeps every hook safe to call unconditionally: it does
// nothing and never throws, so a missing/broken telemetry dependency can
// never take the API down.

export interface SpanHandle {
  /** Attach an error to the span without throwing. */
  recordError(err: unknown): void;
  /** Finish the span without throwing. */
  end(): void;
}

const noopSpan: SpanHandle = {
  recordError(): void {},
  end(): void {},
};

export interface ObservabilityProvider {
  /** Start a span; default returns a no-op handle. Must never throw. */
  startSpan(name: string, attrs?: Record<string, string>): SpanHandle;
  /** Structured log hook; default drops the event. Must never throw. */
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    attrs?: Record<string, string | number | boolean>,
  ): void;
  /** Counter/metric hook; default drops the increment. Must never throw. */
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  /** Error-reporting hook; default drops the error. Must never throw. */
  captureError(err: unknown, context?: Record<string, string>): void;
}

export const noopObservabilityProvider: ObservabilityProvider = {
  startSpan(): SpanHandle {
    return noopSpan;
  },
  log(): void {},
  increment(): void {},
  captureError(): void {},
};

let current: ObservabilityProvider = noopObservabilityProvider;

export function setObservabilityProvider(
  provider: ObservabilityProvider,
): void {
  current = provider;
}

export function getObservabilityProvider(): ObservabilityProvider {
  return current;
}

export function resetObservabilityProvider(): void {
  current = noopObservabilityProvider;
}
