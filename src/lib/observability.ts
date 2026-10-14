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
  /**
   * Run `fn` with `span` as the ambient span for downstream work, so events
   * and child spans attach to it. Optional: providers without context
   * propagation omit it and callers run `fn` directly. Must never throw —
   * on any failure the caller runs `fn` without activation.
   */
  runInSpanContext?<R>(span: SpanHandle, fn: () => R): R;
  /**
   * Trace id of a live span for request-to-trace correlation (surfacing via
   * `X-Trace-Id`). Optional; absent → callers keep the request-id fallback.
   * Must never throw.
   */
  traceIdOf?(span: SpanHandle): string | undefined;
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
  runInSpanContext<R>(_span: SpanHandle, fn: () => R): R {
    return fn();
  },
  traceIdOf(_span: SpanHandle): string | undefined {
    return undefined;
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
