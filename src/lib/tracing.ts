// Phase 18 tracing foundation: OTel-backed ObservabilityProvider.
//
// Thin adapter over `@opentelemetry/api` — no SDK import here, so unit tests
// and environments without a registered SDK get the global no-op tracer and
// every method still succeeds. Delivery is configured outside code via
// `src/instrumentation.ts`: Vercel Trace Drain on Pro+, direct OTLP/HTTP to
// the Datadog intake on Hobby ($0) — see `.env.example`.
//
// Rules (Phases 18–20):
// - Best-effort only: every method catches internally and never throws, so a
//   missing/broken telemetry dependency can never take the API down.
// - Bounded cardinality: span attributes accept only the allowlisted keys
//   below (`route`, `operation`); everything else is dropped. Never put
//   `user_id`, API keys, IPs, video IDs, queries, or request IDs in attrs —
//   correlation rides on the trace id, not per-request values.
// - No secrets: free-text messages pass through `scrubString`, errors through
//   `scrubError`, and structured attrs through `redactObject`.

import type { Context, Span } from "@opentelemetry/api";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  noopObservabilityProvider,
  type ObservabilityProvider,
  type SpanHandle,
} from "./observability";
import { redactObject, scrubError, scrubString } from "./redact";

const TRACER_NAME = "tubelens";

/** Span attribute allowlist: bounded, low-cardinality keys only. */
const ALLOWED_SPAN_KEYS: ReadonlySet<string> = new Set(["route", "operation"]);

/** Cap for any single attribute value (chars). */
const MAX_ATTR_LENGTH = 128;

/** Cap for log-event messages and error summaries (chars). */
const MAX_EVENT_LENGTH = 512;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Allowlisted span attributes: exported for contract tests. */
export function sanitizeSpanAttrs(
  attrs?: Record<string, string>,
): Record<string, string> {
  return sanitizeAttrs(attrs);
}

function sanitizeAttrs(attrs?: Record<string, string>): Record<string, string> {
  if (!attrs || typeof attrs !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!ALLOWED_SPAN_KEYS.has(key) || typeof value !== "string") {
      continue;
    }
    const clean = value.trim();
    if (clean === "") {
      continue;
    }
    out[key] = truncate(clean, MAX_ATTR_LENGTH);
  }
  return out;
}

function errorSummary(err: unknown): string {
  try {
    const scrubbed = scrubError(err);
    if (typeof scrubbed === "string") {
      return truncate(scrubbed, MAX_EVENT_LENGTH);
    }
    if (scrubbed instanceof Error) {
      // scrubError preserves the (scrubbed) message on an Error instance —
      // stringifying would yield "{}", so read the message explicitly. The
      // name is scrubbed too: custom names bypass scrubError's message path.
      const name = scrubString(
        typeof scrubbed.name === "string" && scrubbed.name !== ""
          ? scrubbed.name
          : "Error",
      );
      return truncate(`${name}: ${scrubbed.message}`, MAX_EVENT_LENGTH);
    }
    return truncate(JSON.stringify(scrubbed), MAX_EVENT_LENGTH);
  } catch {
    return "unknown error";
  }
}

/** Scrubbed one-line error summary: exported for contract tests. */
export function errorSummaryForTelemetry(err: unknown): string {
  return errorSummary(err);
}

/**
 * Per-request identifiers must not become indexed span-event attributes —
 * correlation already rides on the trace id. Drops `requestId`-shaped keys
 * (any casing/separator) from already-redacted event context.
 */
function dropRequestIds(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (/^requestids?$/.test(key.toLowerCase().replace(/[_.\-\s]/g, ""))) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Handle → live span mapping for context activation. Never leaks: entries
 * die with their handles, and every method below stays best-effort. */
const spanByHandle = new WeakMap<object, Span>();

/**
 * Pure log-event builder: scrubbed + truncated message with redacted,
 * request-id-free attrs. Exported for contract tests; `log()` below emits
 * exactly what this returns onto the active span.
 */
export function buildLogEvent(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attrs?: Record<string, string | number | boolean>,
): {
  name: string;
  attributes: Record<string, string | number | boolean>;
} {
  const safeAttrs =
    attrs && typeof attrs === "object"
      ? dropRequestIds(redactObject({ ...attrs }))
      : {};
  return {
    name: `tubelens.log.${level}`,
    attributes: {
      message: truncate(scrubString(String(message)), MAX_EVENT_LENGTH),
      ...(safeAttrs as Record<string, string | number | boolean>),
    },
  };
}

class OtelSpanHandle implements SpanHandle {
  constructor(private readonly span: Span) {}

  recordError(err: unknown): void {
    try {
      const message = errorSummary(err);
      this.span.recordException({ message });
      this.span.setStatus({ code: SpanStatusCode.ERROR, message });
    } catch {
      // Intentionally ignored — telemetry must never break a response.
    }
  }

  end(): void {
    try {
      this.span.end();
    } catch {
      // Intentionally ignored — telemetry must never break a response.
    }
  }
}

function noopSpan(): SpanHandle {
  // Reuse the shared no-op provider's span shape without importing internals.
  return noopObservabilityProvider.startSpan("noop");
}

/**
 * Active OTel trace id when a span is sampled/propagated in this context,
 * otherwise undefined. Safe to call anywhere — never throws.
 */
export function resolveActiveTraceId(): string | undefined {
  try {
    return validTraceId(trace.getActiveSpan()?.spanContext()?.traceId);
  } catch {
    // Intentionally ignored — callers fall back to the request id.
  }
  return undefined;
}

function validTraceId(traceId: string | undefined): string | undefined {
  if (
    typeof traceId === "string" &&
    /^[0-9a-f]{32}$/.test(traceId) &&
    traceId !== "00000000000000000000000000000000"
  ) {
    return traceId;
  }
  return undefined;
}

/**
 * OTel-backed provider implementing the Phase 01 seam. Register globally via
 * `setObservabilityProvider(otelObservabilityProvider)` (production startup)
 * or pass per-request through the pipeline's provider overrides (tests).
 */
export const otelObservabilityProvider: ObservabilityProvider = {
  startSpan(name, attrs): SpanHandle {
    try {
      const span = trace
        .getTracer(TRACER_NAME)
        .startSpan(name, { attributes: sanitizeAttrs(attrs) });
      const handle = new OtelSpanHandle(span);
      spanByHandle.set(handle, span);
      return handle;
    } catch {
      return noopSpan();
    }
  },

  runInSpanContext<R>(span: SpanHandle, fn: () => R): R {
    // Exactly-once: only context SETUP is guarded. fn's own throw must
    // propagate to its caller — retrying here would repeat side effects.
    let live: Span | undefined;
    try {
      live = spanByHandle.get(span);
    } catch {
      return fn();
    }
    if (!live) {
      return fn();
    }
    let ambient: Context | undefined;
    try {
      ambient = trace.setSpan(context.active(), live);
    } catch {
      return fn();
    }
    return context.with(ambient, fn);
  },

  traceIdOf(span: SpanHandle): string | undefined {
    try {
      return validTraceId(spanByHandle.get(span)?.spanContext().traceId);
    } catch {
      return undefined;
    }
  },

  log(level, message, attrs): void {
    try {
      const span = trace.getActiveSpan();
      if (!span) {
        return;
      }
      const event = buildLogEvent(level, message, attrs);
      span.addEvent(event.name, event.attributes);
    } catch {
      // Intentionally ignored — telemetry must never break a response.
    }
  },

  increment(): void {
    // Phase 18 is traces-only; counters land with the Phase 20 metric
    // catalog. Kept as a no-op so the seam stays complete and never throws.
  },

  captureError(err, context): void {
    try {
      const span = trace.getActiveSpan();
      if (!span) {
        return;
      }
      const message = errorSummary(err);
      span.recordException({ message });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (context && typeof context === "object") {
        span.addEvent("tubelens.error", {
          message,
          ...dropRequestIds(
            redactObject({ ...context }) as Record<
              string,
              string | number | boolean
            >,
          ),
        });
      }
    } catch {
      // Intentionally ignored — telemetry must never break a response.
    }
  },
};
