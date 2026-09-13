// Phase 01 request pipeline: one typed boundary every route funnels
// through in later phases. Documented order:
//
// request → config → validation → authentication → authorization →
// rate limit → quota → service → upstream/cache → accounting →
// observability → response
//
// In Phase 01 the auth/authz/rate-limit/quota/accounting stages use the
// no-op defaults — the point is the boundary exists, is typed, and is
// testable. Validation, service, and upstream/cache stay inside the route
// handler passed to `withRequestContext`.
//
// Failure policy: provider, handler, and config failures all produce typed
// JSON errors (never HTML, never stacks), always carrying X-Request-Id.
// Observability hooks are best-effort and can never break a response.

import type { NextRequest, NextResponse } from "next/server";
import { type AuthProvider, getAuthProvider } from "./auth";
import { ConfigError, getConfig } from "./config";
import { errorResponse } from "./errors";
import {
  getObservabilityProvider,
  type ObservabilityProvider,
} from "./observability";
import {
  getProductPolicyProvider,
  type ProductPolicyProvider,
} from "./product";
import {
  defaultRateLimitDecision,
  getRateLimitProvider,
  type RateLimitDecision,
  type RateLimitProvider,
} from "./rate-limit";
import {
  buildRequestContext,
  type RequestContext,
  resolveRequestId,
} from "./request-context";
import { getUsageRecorder, type UsageRecorder } from "./usage";

export type RouteHandler = (
  req: NextRequest,
  ctx: RequestContext,
) => Promise<NextResponse> | NextResponse;

/** Injectable provider overrides (tests + later phases). */
export interface PipelineProviders {
  auth?: AuthProvider;
  product?: ProductPolicyProvider;
  rateLimit?: RateLimitProvider;
  usage?: UsageRecorder;
  observability?: ObservabilityProvider;
  /** Env override for config validation (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface PipelineOptions {
  /**
   * Skip the rate-limit check. Liveness probes ONLY — a probe must never
   * 429/503 because of request providers. Enforced by pathname: honored
   * exclusively on /api/v1/health, and any other route requesting it
   * throws a programmer-error ConfigError. Never use for data routes.
   */
  bypassRateLimit?: boolean;
}

/** Bound for best-effort usage accounting: never delay the response. */
const ACCOUNTING_TIMEOUT_MS = 500;

/**
 * The single approved liveness path allowed to bypass rate limiting.
 * Enforced by pathname (not by the route label) so a miswired
 * `bypassRateLimit: true` on any other route fails closed.
 */
const LIVENESS_BYPASS_PATH = "/api/v1/health";

function pick<T>(override: T | undefined, current: T): T {
  return override ?? current;
}

/**
 * Provider-wired RequestContext factory: authentication → tier →
 * entitlements → context. Authorization/quota stages are pass-through in
 * Phase 01 (anonymous callers are authorized for public reads by default).
 * May throw when a provider throws; `withRequestContext` maps that to a
 * typed 503 — call it directly only where the caller handles failures.
 */
export async function createRequestContext(
  req: NextRequest,
  providers: PipelineProviders = {},
  route?: string,
): Promise<RequestContext> {
  const authProvider = pick(providers.auth, getAuthProvider());
  const product = pick(providers.product, getProductPolicyProvider());
  const auth = await authProvider.resolve(req);
  const tier = product.resolveTier(auth);
  const entitlements = product.entitlementsFor(tier);
  return buildRequestContext(req, { auth, tier, entitlements, route });
}

/**
 * Wrap a route handler with the Phase 01 pipeline. The wrapper:
 *  1. validates config (missing security config → typed 503),
 *  2. builds the typed RequestContext (throwing provider → typed 503),
 *  3. runs the rate-limit check (deny → 429 with decision headers;
 *     liveness bypass honored only on /api/v1/health, else throws),
 *  4. invokes the handler (throw → typed 500, never a stack leak),
 *  5. stamps X-Request-Id / X-RateLimit-* from the limiter decision,
 *     preserving the Part A wire contract (defaults match the old stubs),
 *  6. records a usage event via the (no-op) recorder (accounting stage),
 *  7. emits trace/log hooks via best-effort observability (never throws).
 */
export function withRequestContext(
  handler: RouteHandler,
  providers: PipelineProviders = {},
  route?: string,
  options: PipelineOptions = {},
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const observability = pick(
      providers.observability,
      getObservabilityProvider(),
    );
    const span = safeSpan(() =>
      observability.startSpan(route ?? "request", {}),
    );

    // Pre-derive the id so even config/auth failures carry request-id
    // headers and meta.
    const requestId = resolveRequestId(req);

    // Liveness-only invariant: bypassRateLimit is honored exclusively on
    // the approved liveness path. Any other route requesting it is a
    // programmer error and fails closed here (typed, never silent).
    if (
      options.bypassRateLimit &&
      req.nextUrl.pathname !== LIVENESS_BYPASS_PATH
    ) {
      throw new ConfigError(
        "bypassRateLimit is reserved for the liveness probe.",
        "Remove bypassRateLimit from this route; only /api/v1/health may bypass the limiter.",
      );
    }

    // Config stage: security-critical validation fails safely with a typed
    // error; missing optional observability config degrades to no-op.
    try {
      getConfig(providers.env ?? process.env);
    } catch (err) {
      if (err instanceof ConfigError) {
        return errorResponse(requestId, {
          code: err.code,
          message: "Service configuration is incomplete.",
          hint: "Retry shortly; operators must restore the missing security configuration.",
          status: 503,
        });
      }
      throw err;
    }

    // Authentication stage: a throwing provider fails safe with a typed
    // 503, never an unhandled 500 without request-id headers.
    let ctx: RequestContext;
    try {
      ctx = await createRequestContext(req, providers, route);
    } catch (err) {
      safe(() => observability.captureError(err, { requestId }));
      span.recordError(err);
      span.end();
      return errorResponse(requestId, {
        code: "dependency_unavailable",
        message: "Authentication service unavailable.",
        hint: "Retry shortly; the request was rejected rather than served without identity.",
        status: 503,
      });
    }

    // Rate-limit stage (Phase 01: allow-all default). Liveness bypasses
    // only this check; context, ids, and headers still apply.
    const rateLimit = pick(providers.rateLimit, getRateLimitProvider());
    let decision: RateLimitDecision;
    if (options.bypassRateLimit) {
      decision = defaultRateLimitDecision();
    } else {
      try {
        decision = await rateLimit.check({
          identity: ctx.rateLimitIdentity,
          endpointClass: route ?? "default",
          cost: 1,
        });
      } catch (err) {
        // A broken limiter must never silently fail open into unprotected
        // serving nor crash the route: report and fail safely with 503.
        safe(() =>
          observability.captureError(err, { requestId: ctx.requestId }),
        );
        span.recordError(err);
        span.end();
        return errorResponse(ctx.requestId, {
          code: "service_unavailable",
          message: "Rate limiter unavailable.",
          hint: "Retry shortly; the request was not served without protection.",
          status: 503,
        });
      }
    }
    if (!decision.allowed) {
      span.end();
      const res = errorResponse(ctx.requestId, {
        code: "rate_limited",
        message: "Rate limit exceeded.",
        hint: "Slow down and retry after the time in Retry-After.",
        status: 429,
        retryAfter: decision.retryAfter ?? 60,
      });
      // Stamp the limiter decision's values, not the stub defaults.
      res.headers.set("X-RateLimit-Limit", String(decision.limit));
      res.headers.set("X-RateLimit-Remaining", String(decision.remaining));
      res.headers.set("X-RateLimit-Reset", String(decision.reset));
      return res;
    }

    let res: NextResponse;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      safe(() => observability.captureError(err, { requestId: ctx.requestId }));
      span.recordError(err);
      span.end();
      const res = errorResponse(ctx.requestId, {
        code: "internal",
        message: "Internal server error.",
        hint: "Retry the request; report the X-Request-Id if the failure persists.",
        status: 500,
      });
      stampRateLimitHeaders(res, ctx, decision);
      return res;
    }

    stampRateLimitHeaders(res, ctx, decision);

    // Accounting stage (Phase 01: no-op recorder). Best-effort and bounded:
    // recorder invocation is dispatched in a later macrotask so it runs
    // after the route response is delivered, then raced against
    // ACCOUNTING_TIMEOUT_MS; a hung recorder observes an abort via its
    // optional signal, and timeouts/failures vanish through safe().
    // (Nodejs runtime, so setTimeout is always available.)
    const usage = pick(providers.usage, getUsageRecorder());
    setTimeout(() => {
      safe(() => {
        const controller = new AbortController();
        return Promise.race([
          usageRecord(usage, ctx, route, res.ok, controller.signal),
          accountingTimeout(controller),
        ]);
      });
    }, 0);

    safe(() =>
      observability.log("info", "request served", {
        requestId: ctx.requestId,
        route: route ?? "unknown",
        status: res.status,
      }),
    );
    span.end();
    return res;
  };
}

/**
 * Preserve the Part A wire contract: every response carries X-Request-Id
 * (+ meta.requestId, set by the envelope helpers) and X-RateLimit-*.
 * The request id is backfilled only when the handler omitted it; the
 * rate-limit values always come from the limiter decision so success and
 * error responses agree. The Phase 01 allow-all default (100/99) matches
 * the Part A stubs, keeping existing responses byte-identical.
 */
function stampRateLimitHeaders(
  res: NextResponse,
  ctx: RequestContext,
  decision: RateLimitDecision,
): void {
  if (!res.headers.get("X-Request-Id")) {
    res.headers.set("X-Request-Id", ctx.requestId);
  }
  res.headers.set("X-RateLimit-Limit", String(decision.limit));
  res.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  res.headers.set("X-RateLimit-Reset", String(decision.reset));
}

function usageRecord(
  usage: UsageRecorder,
  ctx: RequestContext,
  route: string | undefined,
  ok: boolean,
  signal: AbortSignal,
): Promise<void> | void {
  return usage.record(
    {
      requestId: ctx.requestId,
      route: route ?? "unknown",
      operation: route ?? "unknown",
      cost: 1,
      policyVersion: ctx.entitlements.policyVersion,
      outcome: ok ? "accepted" : "rejected",
      principal: ctx.auth.userId ?? ctx.auth.keyId,
    },
    { signal },
  );
}

/**
 * Bounded cutoff for best-effort accounting: aborts the recorder's signal
 * so hung work can stop, then resolves the race. Unref'd so the timer
 * itself never holds the process open after the response is served.
 */
function accountingTimeout(controller: AbortController): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, ACCOUNTING_TIMEOUT_MS);
    const unrefable = timer as unknown as { unref?: () => void };
    if (typeof unrefable.unref === "function") {
      unrefable.unref();
    }
  });
}

/** Observability is best-effort: hook failures are swallowed, never thrown. */
function safe(fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch(() => {
        // Intentionally ignored — telemetry must never break a response.
      });
    }
  } catch {
    // Intentionally ignored — telemetry must never break a response.
  }
}

function safeSpan(start: () => { recordError(e: unknown): void; end(): void }) {
  try {
    const span = start();
    return {
      recordError(err: unknown): void {
        safe(() => span.recordError(err));
      },
      end(): void {
        safe(() => span.end());
      },
    };
  } catch {
    return {
      recordError(_e: unknown): void {},
      end(): void {},
    };
  }
}
