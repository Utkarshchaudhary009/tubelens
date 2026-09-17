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
import { type AuthContext, type AuthProvider, getAuthProvider } from "./auth";
import {
  type AuthorizeAction,
  can,
  toAuthorizationResponse,
} from "./authorize";
import { ConfigError, getConfig } from "./config";
import { errorResponse } from "./errors";
import { applyCorsHeaders, applySecurityHeaders } from "./http-headers";
import {
  getObservabilityProvider,
  type ObservabilityProvider,
} from "./observability";
import {
  getProductPolicyProvider,
  type ProductPolicyProvider,
} from "./product";
import {
  QUOTA_POLICY_VERSION,
  QuotaPolicyError,
  resolveOperationCost,
} from "./quota";
import {
  defaultRateLimitDecision,
  getRateLimitProvider,
  type RateLimitDecision,
  type RateLimitProvider,
} from "./rate-limit";
import { redactObject, scrubError } from "./redact";
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
   * fails closed with a typed 500. Never use for data routes.
   */
  bypassRateLimit?: boolean;
  /**
   * Override the authorization-stage baseline action. Tests ONLY — lets a
   * test force a real pipeline authorization denial (e.g.
   * `users:mutate-role`) and assert its status/headers. Defaults to
   * `read:public`, which allows every principal, so production behavior is
   * byte-identical. Never set in production routes.
   */
  authorizationAction?: AuthorizeAction;
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
 * entitlements → context. This factory does NOT enforce authorization — it
 * never calls `can()`; the authorization stage lives in
 * `withRequestContext` below, and per-route sensitive actions are enforced
 * in handlers via `can()` / `requireOwnerOrAdmin()` / `requireScope()`.
 * Callers of this factory must not assume the returned context is
 * authorized for anything beyond identity/tier. May throw when a provider
 * throws; `withRequestContext` maps that to a typed 503 — call it directly
 * only where the caller handles failures.
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
 *  2. resolves identity (auth throw → typed 503) and policy tier +
 *     entitlements (policy throw → typed 503 with its own classification),
 *  3. evaluates the authorization baseline through the matrix (deny →
 *     typed 401/403 with rate-limit headers; the default `read:public`
 *     baseline allows every principal),
 *  4. runs the rate-limit check (deny → 429 with decision headers;
 *     liveness bypass honored only on /api/v1/health, else a typed 500),
 *  5. invokes the handler (throw → typed 500, never a stack leak),
 *  6. stamps X-Request-Id / X-RateLimit-* from the limiter decision,
 *     preserving the Part A wire contract (defaults match the old stubs),
 *  7. records a usage event via the (no-op) recorder (accounting stage),
 *  8. emits trace/log hooks via best-effort observability (never throws).
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
    // Phase 09: the request Origin threads into every error/success return
    // below so real responses carry the CORS grant for allowlisted origins
    // (never `*`, no credentials).
    const origin = req.headers.get("origin");

    // Liveness-only invariant: bypassRateLimit is honored exclusively on
    // the approved liveness path. Any other route requesting it is a
    // programmer error and fails closed here with a typed 500 (never an
    // unhandled throw, which would escape as framework HTML).
    if (
      options.bypassRateLimit &&
      req.nextUrl.pathname !== LIVENESS_BYPASS_PATH
    ) {
      const err = new ConfigError(
        "bypassRateLimit is reserved for the liveness probe.",
        "Remove bypassRateLimit from this route; only /api/v1/health may bypass the limiter.",
      );
      safe(() => observability.captureError(scrubError(err), { requestId }));
      span.recordError(scrubError(err));
      span.end();
      return errorResponse(requestId, {
        code: "internal",
        message: "Service route misconfigured.",
        hint: "Report the X-Request-Id; operators must remove bypassRateLimit from this route.",
        status: 500,
        origin,
      });
    }

    // Config stage: security-critical validation fails safely with a typed
    // error; missing optional observability config degrades to no-op.
    try {
      getConfig(providers.env ?? process.env);
    } catch (err) {
      if (err instanceof ConfigError) {
        safe(() => observability.captureError(scrubError(err), { requestId }));
        span.recordError(scrubError(err));
        span.end();
        return errorResponse(requestId, {
          code: err.code,
          message: "Service configuration is incomplete.",
          hint: "Retry shortly; operators must restore the missing security configuration.",
          status: 503,
          origin,
        });
      }
      throw err;
    }

    // Authentication stage: a throwing auth provider fails safe with a
    // typed 503, never an unhandled 500 without request-id headers.
    const authProvider = pick(providers.auth, getAuthProvider());
    const product = pick(providers.product, getProductPolicyProvider());
    let auth: AuthContext;
    try {
      auth = await authProvider.resolve(req);
    } catch (err) {
      safe(() => observability.captureError(scrubError(err), { requestId }));
      span.recordError(scrubError(err));
      span.end();
      return errorResponse(requestId, {
        code: "dependency_unavailable",
        message: "Authentication service unavailable.",
        hint: "Retry shortly; the request was rejected rather than served without identity.",
        status: 503,
        origin,
      });
    }

    // Policy stage: tier + entitlements. A throwing policy provider is a
    // different outage than auth — classify it as the dependency it is so
    // operators don't chase the identity stack for a policy-store fault.
    let ctx: RequestContext;
    try {
      const tier = product.resolveTier(auth);
      const entitlements = product.entitlementsFor(tier);
      ctx = buildRequestContext(req, { auth, tier, entitlements, route });
    } catch (err) {
      safe(() => observability.captureError(scrubError(err), { requestId }));
      span.recordError(scrubError(err));
      span.end();
      return errorResponse(requestId, {
        code: "service_unavailable",
        message: "Product policy unavailable.",
        hint: "Retry shortly; the request was rejected rather than served without an entitlement decision.",
        status: 503,
        origin,
      });
    }

    // Authorization stage (Phase 07): the baseline grant is evaluated
    // through the matrix post-auth instead of a pass-through. The default
    // `read:public` allows every principal (anonymous included), so
    // public-route behavior stays byte/shape identical — the stage exists
    // so the decision function is exercised on every request and sensitive
    // per-route actions reuse it in handlers. `options.authorizationAction`
    // (tests only) swaps the baseline to force a real denial. A denial
    // fails closed with a typed 401/403, never a handler throw.
    const baselineDenied = toAuthorizationResponse(
      ctx.requestId,
      can({
        action: options.authorizationAction ?? "read:public",
        ctx: ctx.auth,
      }),
    );
    if (baselineDenied) {
      span.end();
      // Contract: EVERY response carries X-RateLimit-* — stamp the stub
      // allow-all decision here, exactly like the handler-throw path below
      // (errorResponse already sets stub values via baseHeaders; this keeps
      // the pipeline the single stamper so values never drift).
      stampRateLimitHeaders(
        baselineDenied,
        ctx,
        defaultRateLimitDecision(),
        origin,
      );
      return baselineDenied;
    }

    // Rate-limit stage (Phase 01: allow-all default). Liveness bypasses
    // only this check; context, ids, and headers still apply.
    const rateLimit = pick(providers.rateLimit, getRateLimitProvider());
    // Phase 13: the limiter is weighted by the catalog cost, resolved BEFORE
    // the limiter try-block. An unlabeled call keeps the legacy cost-1
    // default; a DEFINED but unknown label is programmer error (like the
    // bypassRateLimit misuse above) and fails closed with a typed 500 —
    // never free, and never misreported as a 503 dependency outage.
    let operationCost = 1;
    if (route !== undefined) {
      try {
        operationCost = resolveOperationCost(route).cost;
      } catch (err) {
        safe(() =>
          observability.captureError(scrubError(err), {
            requestId: ctx.requestId,
          }),
        );
        span.recordError(scrubError(err));
        span.end();
        return errorResponse(ctx.requestId, {
          code: "internal",
          message: "Service route misconfigured.",
          hint: "Report the X-Request-Id; route has no priced operation.",
          status: 500,
          origin,
        });
      }
    }
    let decision: RateLimitDecision;
    if (options.bypassRateLimit) {
      decision = defaultRateLimitDecision();
    } else {
      try {
        decision = await rateLimit.check({
          identity: ctx.rateLimitIdentity,
          endpointClass: route ?? "default",
          cost: operationCost,
        });
      } catch (err) {
        // A broken limiter must never silently fail open into unprotected
        // serving nor crash the route: report and fail safely with 503.
        safe(() =>
          observability.captureError(scrubError(err), {
            requestId: ctx.requestId,
          }),
        );
        span.recordError(scrubError(err));
        span.end();
        return errorResponse(ctx.requestId, {
          code: "service_unavailable",
          message: "Rate limiter unavailable.",
          hint: "Retry shortly; the request was not served without protection.",
          status: 503,
          origin,
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
        origin,
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
      safe(() =>
        observability.captureError(scrubError(err), {
          requestId: ctx.requestId,
        }),
      );
      span.recordError(scrubError(err));
      span.end();
      const res = errorResponse(ctx.requestId, {
        code: "internal",
        message: "Internal server error.",
        hint: "Retry the request; report the X-Request-Id if the failure persists.",
        status: 500,
        origin,
      });
      stampRateLimitHeaders(res, ctx, decision, origin);
      return res;
    }

    stampRateLimitHeaders(res, ctx, decision, origin);

    // Accounting stage (Phase 01: no-op recorder). Best-effort and bounded:
    // recorder invocation is dispatched in a later macrotask so it runs
    // after the route response is delivered, then raced against
    // ACCOUNTING_TIMEOUT_MS; a hung recorder observes an abort via its
    // optional signal, and timeouts/failures vanish through safe().
    // (Nodejs runtime, so setTimeout is always available.)
    // NOTE: a bare setTimeout macrotask may be dropped on serverless when
    // the function is frozen after the response. Migrate this dispatch to
    // waitUntil (Ph.13–14 durable usage) once the runtime handle is
    // threaded through the pipeline — no behavior change until then.
    const usage = pick(providers.usage, getUsageRecorder());
    setTimeout(() => {
      safe(() => {
        const controller = new AbortController();
        return Promise.race([
          usageRecord(
            usage,
            ctx,
            route,
            res.ok,
            controller.signal,
            observability,
          ),
          accountingTimeout(controller),
        ]);
      });
    }, 0);

    safe(() =>
      observability.log(
        "info",
        "request served",
        redactObject({
          requestId: ctx.requestId,
          route: route ?? "unknown",
          status: res.status,
        }),
      ),
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
  origin?: string | null,
): void {
  if (!res.headers.get("X-Request-Id")) {
    res.headers.set("X-Request-Id", ctx.requestId);
  }
  res.headers.set("X-RateLimit-Limit", String(decision.limit));
  res.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  res.headers.set("X-RateLimit-Reset", String(decision.reset));
  // Phase 09: handler-built raw responses bypass baseHeaders — backfill the
  // security baseline here so headers survive every status incl. 4xx/5xx.
  // The request origin grants CORS the same way (never `*`, no credentials).
  applySecurityHeaders(res.headers);
  applyCorsHeaders(res.headers, origin ?? null);
}

function usageRecord(
  usage: UsageRecorder,
  ctx: RequestContext,
  route: string | undefined,
  ok: boolean,
  signal: AbortSignal,
  observability: ObservabilityProvider,
): Promise<void> | void {
  // Phase 13: credit rows stamp the resolved catalog record, and the QUOTA
  // policy version is authoritative for them (not the entitlements
  // snapshot). An unlabeled call keeps the legacy unknown/1 stub.
  const outcome = ok ? "accepted" : "rejected";
  const principal = ctx.auth.userId ?? ctx.auth.keyId;
  if (route === undefined) {
    return usage.record(
      {
        requestId: ctx.requestId,
        route: "unknown",
        operation: "unknown",
        cost: 1,
        policyVersion: QUOTA_POLICY_VERSION,
        outcome,
        principal,
      },
      { signal },
    );
  }
  let operation: string;
  let cost: number;
  let policyVersion: string;
  try {
    const resolved = resolveOperationCost(route);
    operation = resolved.operation;
    cost = resolved.cost;
    policyVersion = resolved.policyVersion;
  } catch {
    // Unpriced labels must not mint credit rows — record nothing, but emit
    // so a miswired route is observable instead of silent.
    safe(() =>
      observability.captureError(
        scrubError(
          new QuotaPolicyError(
            "unknown_operation",
            "Route has no priced operation.",
          ),
        ),
        { requestId: ctx.requestId },
      ),
    );
    return;
  }
  return usage.record(
    {
      requestId: ctx.requestId,
      route,
      operation,
      cost,
      policyVersion,
      outcome,
      principal,
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
