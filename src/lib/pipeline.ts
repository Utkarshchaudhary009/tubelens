// Phase 01 request pipeline: one typed boundary every route funnels
// through in later phases. Documented order:
//
// request → validation → authentication → authorization → rate limit →
// quota → service → upstream/cache → accounting → observability → response
//
// In Phase 01 the auth/authz/rate-limit/quota/accounting stages use the
// no-op defaults — the point is the boundary exists, is typed, and is
// testable. Validation, service, and upstream/cache stay inside the route
// handler passed to `withRequestContext`.

import type { NextRequest, NextResponse } from "next/server";
import { type AuthProvider, getAuthProvider } from "./auth";
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
  getRateLimitProvider,
  type RateLimitDecision,
  type RateLimitProvider,
} from "./rate-limit";
import { buildRequestContext, type RequestContext } from "./request-context";
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
}

function pick<T>(override: T | undefined, current: T): T {
  return override ?? current;
}

/**
 * Provider-wired RequestContext factory: authentication → tier →
 * entitlements → context. Authorization/quota stages are pass-through in
 * Phase 01 (anonymous callers are authorized for public reads by default).
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
 *  1. builds the typed RequestContext (authentication stage),
 *  2. runs the rate-limit check (allow-all default),
 *  3. invokes the handler (validation → service → upstream/cache),
 *  4. backfills X-Request-Id / X-RateLimit-* when the handler did not set
 *     them, preserving the Part A wire contract byte-for-byte,
 *  5. records a usage event via the (no-op) recorder (accounting stage),
 *  6. emits trace/log hooks via the (no-op) observability provider.
 */
export function withRequestContext(
  handler: RouteHandler,
  providers: PipelineProviders = {},
  route?: string,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const observability = pick(
      providers.observability,
      getObservabilityProvider(),
    );
    const span = safeSpan(() =>
      observability.startSpan(route ?? "request", {}),
    );

    const ctx = await createRequestContext(req, providers, route);

    // Rate-limit stage (Phase 01: allow-all default).
    const rateLimit = pick(providers.rateLimit, getRateLimitProvider());
    let decision: RateLimitDecision;
    try {
      decision = await rateLimit.check({
        identity: ctx.rateLimitIdentity,
        endpointClass: route ?? "default",
        cost: 1,
      });
    } catch (err) {
      // A broken limiter must never silently fail open into unprotected
      // serving nor crash the route: report and fail safely with 503.
      observability.captureError(err, { requestId: ctx.requestId });
      span.recordError(err);
      span.end();
      return errorResponse(ctx.requestId, {
        code: "service_unavailable",
        message: "Rate limiter unavailable.",
        hint: "Retry shortly; the request was not served without protection.",
        status: 503,
      });
    }
    if (!decision.allowed) {
      span.end();
      return errorResponse(ctx.requestId, {
        code: "rate_limited",
        message: "Rate limit exceeded.",
        hint: "Slow down and retry after the time in Retry-After.",
        status: 429,
        retryAfter: decision.retryAfter ?? 60,
      });
    }

    let res: NextResponse;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      observability.captureError(err, { requestId: ctx.requestId });
      span.recordError(err);
      span.end();
      throw err;
    }

    applyRateLimitHeaders(res, ctx, decision);

    // Accounting stage (Phase 01: no-op recorder).
    const usage = pick(providers.usage, getUsageRecorder());
    try {
      await usage.record({
        requestId: ctx.requestId,
        route: route ?? "unknown",
        operation: route ?? "unknown",
        cost: 1,
        policyVersion: ctx.entitlements.policyVersion,
        outcome: res.ok ? "accepted" : "rejected",
        principal: ctx.auth.userId ?? ctx.auth.keyId,
      });
    } catch (err) {
      // Accounting must never break a served response.
      observability.captureError(err, { requestId: ctx.requestId });
    }

    observability.log("info", "request served", {
      requestId: ctx.requestId,
      route: route ?? "unknown",
      status: res.status,
    });
    span.end();
    return res;
  };
}

/**
 * Preserve the Part A wire contract: every response carries X-Request-Id
 * (+ meta.requestId, set by the envelope helpers) and X-RateLimit-*. Only
 * backfill headers the handler did not already set, so routes using
 * successResponse/errorResponse keep byte-identical output.
 */
function applyRateLimitHeaders(
  res: NextResponse,
  ctx: RequestContext,
  decision: RateLimitDecision,
): void {
  if (!res.headers.get("X-Request-Id")) {
    res.headers.set("X-Request-Id", ctx.requestId);
  }
  if (!res.headers.get("X-RateLimit-Limit")) {
    res.headers.set("X-RateLimit-Limit", String(decision.limit));
  }
  if (!res.headers.get("X-RateLimit-Remaining")) {
    res.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  }
  if (!res.headers.get("X-RateLimit-Reset")) {
    res.headers.set("X-RateLimit-Reset", String(decision.reset));
  }
}

function safeSpan(start: () => { recordError(e: unknown): void; end(): void }) {
  try {
    return start();
  } catch {
    return {
      recordError(_e: unknown): void {},
      end(): void {},
    };
  }
}
