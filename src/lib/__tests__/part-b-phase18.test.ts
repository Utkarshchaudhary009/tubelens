import { afterEach, describe, expect, test } from "bun:test";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { NextRequest, NextResponse } from "next/server";
import { anonymousAuthContext } from "../auth";
import { successResponse } from "../envelope";
import {
  noopObservabilityProvider,
  resetObservabilityProvider,
} from "../observability";
import { withRequestContext } from "../pipeline";
import { FREE_ENTITLEMENTS } from "../product";
import { buildRequestContext } from "../request-context";
import {
  buildLogEvent,
  errorSummaryForTelemetry,
  otelObservabilityProvider,
  resolveActiveTraceId,
  sanitizeSpanAttrs,
} from "../tracing";

let exporter: InMemorySpanExporter | undefined;
let provider: NodeTracerProvider | undefined;

/** Register a recording tracer + async context manager for one test. */
function useRecordingTracer(): InMemorySpanExporter {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return exporter;
}

afterEach(async () => {
  resetObservabilityProvider();
  exporter?.reset();
  exporter = undefined;
  try {
    await provider?.shutdown();
  } catch {
    // Intentionally ignored — test teardown only.
  }
  provider = undefined;
  try {
    trace.disable();
  } catch {
    // Intentionally ignored — test teardown only.
  }
  try {
    context.disable();
  } catch {
    // Intentionally ignored — test teardown only.
  }
});

function req(url: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, { headers });
}

function ctxInputs(route?: string) {
  return {
    auth: anonymousAuthContext,
    tier: "free" as const,
    entitlements: FREE_ENTITLEMENTS,
    ...(route ? { route } : {}),
  };
}

describe("Phase 18 tracing foundation", () => {
  test("instrumentation module exports a register function", async () => {
    const mod = await import("../../instrumentation");
    expect(typeof mod.register).toBe("function");
  });

  test("otel provider never throws on any hook, even with garbage", () => {
    expect(() => {
      const span = otelObservabilityProvider.startSpan("request", {});
      span.recordError(new Error("boom"));
      span.recordError(undefined);
      span.end();
      otelObservabilityProvider.log("info", "hello", { route: "x" });
      otelObservabilityProvider.log("error", "bad", undefined);
      otelObservabilityProvider.increment("tubelens.requests.total", 1, {
        route: "health",
      });
      otelObservabilityProvider.captureError(new Error("cap"), {
        requestId: "r1",
      });
      otelObservabilityProvider.captureError("string-error");
      otelObservabilityProvider.runInSpanContext?.(span, () => "ok");
      otelObservabilityProvider.traceIdOf?.(span);
    }).not.toThrow();
  });

  test("span attrs allowlist keeps route/operation, drops everything else", () => {
    expect(
      sanitizeSpanAttrs({
        route: "health",
        operation: "health.check",
        user_id: "user_123",
        videoId: "dQw4w9WgXcQ",
        requestId: "caller-1",
      }),
    ).toEqual({ route: "health", operation: "health.check" });
  });

  test("span attrs drop blanks/non-strings and truncate long values to 128", () => {
    const longRoute = "r".repeat(500);
    const attrs = sanitizeSpanAttrs({
      route: longRoute,
      operation: "   ",
    });
    expect(attrs.route).toHaveLength(128);
    expect(attrs.operation).toBeUndefined();
    expect(sanitizeSpanAttrs(undefined)).toEqual({});
  });

  test("error summary preserves scrubbed Error messages (never '{}')", () => {
    expect(errorSummaryForTelemetry(new Error("boom"))).toBe("Error: boom");
    expect(errorSummaryForTelemetry("plain failure")).toBe("plain failure");
    // Secret-bearing messages are scrubbed, not leaked.
    const withKey = errorSummaryForTelemetry(
      new Error("call failed DATADOG_API_KEY=supersecretvalue"),
    );
    expect(withKey).not.toContain("supersecretvalue");
    expect(withKey).toContain("DATADOG_API_KEY=");
  });

  test("error summary scrubs secret-shaped custom error names", () => {
    const err = new Error("boom");
    err.name = "ak_testsupersecretkey";
    expect(errorSummaryForTelemetry(err)).not.toContain("ak_testsupersecret");
  });

  test("log events scrub secrets, drop request ids, truncate", () => {
    const event = buildLogEvent("info", "served DATADOG_API_KEY=topsecretkey", {
      requestId: "caller-9",
      route: "health",
      status: 200,
    });
    expect(event.name).toBe("tubelens.log.info");
    expect(event.attributes.message).not.toContain("topsecretkey");
    expect(event.attributes.requestId).toBeUndefined();
    expect(event.attributes.route).toBe("health");
    const long = buildLogEvent("error", "x".repeat(900));
    expect(String(long.attributes.message)).toHaveLength(512);
  });

  test("resolveActiveTraceId falls back to undefined without an SDK", () => {
    expect(resolveActiveTraceId()).toBeUndefined();
  });

  test("traceId falls back to requestId when no span is active", () => {
    const ctx = buildRequestContext(
      req("http://x/api/v1/health", "caller-trace-1"),
      ctxInputs("health"),
    );
    expect(ctx.requestId).toBe("caller-trace-1");
    expect(ctx.traceId).toBe("caller-trace-1");
  });

  test("recording tracer: route span carries sanitized attrs", () => {
    const rec = useRecordingTracer();
    const span = otelObservabilityProvider.startSpan("health", {
      route: "health",
      user_id: "user_123",
    });
    span.end();
    const finished = rec.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.attributes).toEqual({ route: "health" });
  });

  test("recording tracer: recordError marks ERROR with the real message", () => {
    const rec = useRecordingTracer();
    const span = otelObservabilityProvider.startSpan("search", {
      route: "search",
    });
    span.recordError(new Error("upstream gone"));
    span.end();
    const finished = rec.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(finished[0]?.status.message).toBe("Error: upstream gone");
    expect(finished[0]?.events.some((e) => e.name === "exception")).toBe(true);
  });

  test("recording tracer: runInSpanContext activates the span", () => {
    useRecordingTracer();
    const span = otelObservabilityProvider.startSpan("health", {
      route: "health",
    });
    const inside = otelObservabilityProvider.runInSpanContext?.(span, () =>
      resolveActiveTraceId(),
    );
    expect(typeof inside).toBe("string");
    expect(inside).toBe(otelObservabilityProvider.traceIdOf?.(span));
    expect(resolveActiveTraceId()).toBeUndefined();
    span.end();
  });

  test("recording tracer: log + captureError attach to the active span", () => {
    const rec = useRecordingTracer();
    const span = otelObservabilityProvider.startSpan("health", {
      route: "health",
    });
    otelObservabilityProvider.runInSpanContext?.(span, () => {
      otelObservabilityProvider.log("info", "request served", {
        requestId: "caller-1",
        route: "health",
      });
      otelObservabilityProvider.captureError(new Error("cap"), {
        requestId: "caller-1",
      });
    });
    span.end();
    const finished = rec.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const names = finished[0]?.events.map((e) => e.name) ?? [];
    expect(names).toContain("tubelens.log.info");
    expect(names).toContain("tubelens.error");
    const logEvent = finished[0]?.events.find(
      (e) => e.name === "tubelens.log.info",
    );
    expect(logEvent?.attributes?.requestId).toBeUndefined();
  });

  test("representative request emits one route span + X-Trace-Id", async () => {
    const rec = useRecordingTracer();
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { observability: otelObservabilityProvider },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "trace-rep-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("trace-rep-1");
    const traceId = res.headers.get("X-Trace-Id");
    expect(typeof traceId).toBe("string");
    const finished = rec.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.name).toBe("health");
    expect(finished[0]?.attributes).toEqual({ route: "health" });
    expect(traceId).toBe(finished[0]?.spanContext().traceId);
  });

  test("upstream failure records the error span and returns typed JSON", async () => {
    const rec = useRecordingTracer();
    const run = withRequestContext(
      async () => {
        throw new Error("upstream gone");
      },
      { observability: otelObservabilityProvider },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=x"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; hint: string };
    };
    expect(body.error.code).toBe("internal");
    expect(typeof body.error.hint).toBe("string");
    const finished = rec.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(finished[0]?.status.message).toBe("Error: upstream gone");
  });

  test("noop provider keeps the pipeline byte-identical without an SDK", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { observability: noopObservabilityProvider },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "noop-1"));
    expect(res.status).toBe(200);
    // Without instrumentation the trace id falls back to the request id.
    expect(res.headers.get("X-Trace-Id")).toBe("noop-1");
  });

  test("handler-returned error statuses stay untouched responses", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        new NextResponse(
          JSON.stringify({
            data: null,
            page: { next: null },
            meta: { requestId: ctx.requestId },
            error: {
              code: "transcript_unavailable",
              message: "Gone",
              hint: "Retry later.",
              status: 500,
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      { observability: otelObservabilityProvider },
      "transcript",
    );
    const res = await run(req("http://x/api/v1/videos/abc/transcript"));
    expect(res.status).toBe(500);
  });
});
