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
// Phase 15 separation (hardening, no new infra): rate-limit answers
// "can-request-now" (cost resolved from quota.ts BEFORE the check), the
// quota stage answers "allowance remains" (peek pre-handler, consume
// post-response — the CHARGE is synchronous in-request, never deferred),
// and the cache inside the handler answers only "can upstream be avoided".
// A cache hit still passes rate-limit + quota and still consumes; no stage
// reads another stage's state as its source of truth.
//
// Failure policy: provider, handler, and config failures all produce typed
// JSON errors (never HTML, never stacks), always carrying X-Request-Id.
// Observability hooks are best-effort and can never break a response.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ABUSE_ENFORCE_TIMEOUT_MS,
  type AbuseOutcome,
  type AbuseVerdict,
  enforceAbuseVerdict,
  noteAbuseOutcome,
} from "./abuse";
import type { ApiKeysClient } from "./api-keys";
import { type AuthContext, type AuthProvider, getAuthProvider } from "./auth";
import {
  type AuthorizeAction,
  can,
  toAuthorizationResponse,
} from "./authorize";
import {
  BATCH_CHILD_HEADER,
  BATCH_PARTIAL_HEADER,
  getBatchMarkerSecrets,
  verifyBatchChildMarker,
} from "./batch-marker";
import type { ClerkAdminClient } from "./clerk-admin";
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
  allowanceForTier,
  checkAllowance,
  getQuotaStore,
  idempotencyKey,
  type QuotaCheck,
  type QuotaDecision,
  type QuotaStore,
  quotaPrincipal,
  quotaWindowFor,
  recordConsumption,
} from "./quota-accounting";
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
import {
  getUsageRecorder,
  type UsageChildCost,
  type UsageRecorder,
} from "./usage";

export type RouteHandler = (
  req: NextRequest,
  ctx: RequestContext,
) => Promise<NextResponse> | NextResponse;

/** Injectable provider overrides (tests + later phases). */
export interface PipelineProviders {
  auth?: AuthProvider;
  product?: ProductPolicyProvider;
  rateLimit?: RateLimitProvider;
  /** Monthly allowance store (Phase 14); defaults to the shared store. */
  quotaStore?: QuotaStore;
  /** Phase 17 abuse-enforcement clients (tests); default to live singletons. */
  abuseClerk?: ClerkAdminClient;
  abuseKeys?: ApiKeysClient;
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
  /**
   * Phase 16 batch economics: per-request summed weighted-credit cost that
   * replaces the catalog's static label cost for THIS admission only. The
   * batch route prices its children preflight (costForBatch) and passes the
   * total here, so one batch faces exactly one rate-limit weight and one
   * quota peek+consume. Must be a finite integer >= 1 (the quota and
   * limiter stages fail closed below that floor); anything else is
   * programmer error and fails closed with a typed 500. The operation name
   * and policy version still come from the catalog.
   */
  costOverride?: number;
  /**
   * Phase 16 zero-work batches: admitted for auth, rate-limit (weighted by
   * costOverride), and observability, but EXEMPT from the quota peek and
   * consume — nothing executed, so nothing is billable. The usage row still
   * emits with cost 0. Never set for batches that executed children.
   */
  quotaExempt?: boolean;
  /**
   * Phase 16 batch economics: priced runnable-child summary stamped on the
   * batch's SINGLE usage row (summed cost + child count + policy version),
   * never one row per child. Only honored alongside a priced route label.
   */
  usageChildren?: UsageChildCost[];
}

/** Bound for best-effort usage accounting: never delay the response. */
const ACCOUNTING_TIMEOUT_MS = 500;

/**
 * The single approved liveness path allowed to bypass rate limiting.
 * Enforced by pathname (not by the route label) so a miswired
 * `bypassRateLimit: true` on any other route fails closed.
 */
const LIVENESS_BYPASS_PATH = "/api/v1/health";

/**
 * Route labels exempt from quota peek AND consume. Balance reads must be
 * FREE: an exhausted caller must still be able to read their balance (a
 * 429 on the balance endpoint would hide the reset they need), and
 * polling must not tax the monthly allowance. The usage event still
 * records the attempt (observability, not charging — the single-writer
 * rule means only store writes feed balances).
 */
const QUOTA_FREE_ROUTES: ReadonlySet<string> = new Set(["quota"]);

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
 *     liveness bypass honored only on /api/v1/health, else a typed 500;
 *     `options.costOverride` — Phase 16 batch summed total — replaces the
 *     static label cost as this admission's single weight),
 *  5. peeks the monthly quota allowance (deny → 429 `quota_exceeded`
 *     with `Retry-After`; rejections consume nothing; liveness bypass
 *     and the free `quota` balance-read label skip the stage),
 *  6. invokes the handler (throw → typed 500, never a stack leak, never
 *     charged),
 *  7. records the admitted attempt's consumption (attempt-based: error
 *     responses still charge; store failure → typed 503),
 *  8. stamps X-Request-Id / X-RateLimit-* from the limiter decision,
 *     preserving the Part A wire contract (defaults match the old stubs),
 *  9. records a usage event via the (no-op) recorder (accounting stage;
 *     verified already-billed batch children record nothing — the parent's
 *     single row covers the fan-out),
 *  10. emits trace/log hooks via best-effort observability (never throws).
 *
 * Phase 16 verified batch children (server-minted HMAC marker): skip the
 * rate-limit weight, quota peek/consume, and usage row — the parent batch
 * admission already charged the summed cost. Unverifiable markers fall
 * through to normal admission (fail toward charging).
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
      // Phase 17: a 401 baseline denial is an auth-failure signal.
      // Response-neutral — the 401 above is already built. 403
      // scope/permission denials are NOT credential failures and are never
      // counted (counting them would revoke callers for permission denials).
      if (baselineDenied.status === 401) {
        await observeAbuseOutcome(ctx, route, "auth_failure", {
          clerk: providers.abuseClerk,
          keys: providers.abuseKeys,
        });
      }
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
    // Phase 14 reuses the same resolved record for the quota stage below.
    let operation: string | undefined;
    let operationCost = 1;
    let operationPolicyVersion = QUOTA_POLICY_VERSION;
    if (route !== undefined) {
      try {
        const resolved = resolveOperationCost(route);
        operation = resolved.operation;
        operationCost = resolved.cost;
        operationPolicyVersion = resolved.policyVersion;
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
    // Phase 16: a per-request cost override (batch summed total) replaces
    // the static label cost for this admission's rate-limit weight, quota
    // peek/consume, and usage row. Invalid overrides are programmer error
    // (like an unpriced label above) and fail closed with a typed 500 —
    // never free, never silently clamped.
    if (options.costOverride !== undefined) {
      if (!Number.isInteger(options.costOverride) || options.costOverride < 1) {
        safe(() =>
          observability.captureError(
            scrubError(
              new QuotaPolicyError(
                "invalid_quota_cost",
                "Route passed an invalid cost override.",
              ),
            ),
            { requestId: ctx.requestId },
          ),
        );
        span.recordError(
          scrubError(
            new QuotaPolicyError(
              "invalid_quota_cost",
              "Route passed an invalid cost override.",
            ),
          ),
        );
        span.end();
        return errorResponse(ctx.requestId, {
          code: "internal",
          message: "Service route misconfigured.",
          hint: "Report the X-Request-Id; route passed an invalid quota cost.",
          status: 500,
          origin,
        });
      }
      operationCost = options.costOverride;
    }
    // Phase 16 already-billed batch child: the parent batch was admitted
    // once with the summed child cost, and each child carries a
    // server-minted HMAC for exactly this method + path. A VERIFIED marker
    // skips the rate-limit weight, the quota peek/consume, and the usage
    // row — the parent's single charge and single row cover the whole
    // fan-out, so re-admitting children would double-charge. A forged
    // marker, or a marker with no secret configured, is IGNORED (normal
    // admission below) — fail toward charging, never toward free serving.
    // Auth, authorization, handler, and headers still apply.
    let batchChildBilled = false;
    const childMarker = req.headers.get(BATCH_CHILD_HEADER);
    if (childMarker) {
      // Any configured secret verifies (current, rotation-previous, Clerk
      // fallback) — a redeploy mid-fan-out must not turn valid children
      // into double charges.
      const secrets = getBatchMarkerSecrets(providers.env ?? process.env);
      batchChildBilled = secrets.some((secret) =>
        verifyBatchChildMarker(
          secret,
          req.method,
          req.nextUrl.pathname + req.nextUrl.search,
          childMarker,
        ),
      );
    }
    let decision: RateLimitDecision;
    if (options.bypassRateLimit) {
      decision = defaultRateLimitDecision();
    } else if (batchChildBilled) {
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
      let res = errorResponse(ctx.requestId, {
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
      // Phase 17: count the 429 toward abuse controls. The 429 above is
      // already built; enforcement on a revoke-level verdict is awaited
      // inside the fail-fast budget (rare — only threshold-crossers pay it),
      // and a warn stamps Retry-After + warnings[] per the Phase 17 table.
      const verdict = await observeAbuseOutcome(ctx, route, "rate_limited", {
        clerk: providers.abuseClerk,
        keys: providers.abuseKeys,
      });
      if (verdict === "warn") {
        res = await withAbuseWarn(
          res,
          "Repeated rate-limit hits flagged by abuse controls; slow down and retry after the time in Retry-After.",
        );
      }
      return res;
    }

    // Quota stage (Phase 14): monthly weighted-credit allowance per
    // PLANS_AND_USAGE.md §7 ("how much allowance consumed this period?").
    // Peek-then-consume: the pre-handler peek (read-only) rejects exhausted
    // callers with 429 BEFORE any upstream work, and consumption is recorded
    // only after the handler produces a response below. Attempt-based
    // charging — an admitted attempt is charged even when upstream fails;
    // quota rejections never consume, and a handler throw (our crash, no
    // response) never reaches the consume step. Liveness bypass skips the
    // stage (a probe must never 429), as do the QUOTA_FREE_ROUTES labels
    // (balance reads are free); unlabeled calls keep the legacy behavior
    // (no priced operation to charge). A broken quota store fails
    // closed with a typed 503 — never silently served without accounting.
    // `nowMs` is captured once per request and threaded through the peek,
    // the consume, retry-after, and usage rows so a month-boundary straddle
    // mid-request cannot split consume vs record across windows.
    const usage = pick(providers.usage, getUsageRecorder());
    const nowMs = Date.now();
    const principal = quotaPrincipal(ctx);
    let quotaStore: QuotaStore | undefined;
    let quotaCheck: QuotaCheck | undefined;
    let quotaDecision: QuotaDecision | undefined;
    // Verified batch children skip the peek: the parent already covered
    // their cost, so there is nothing to peek for and (with quotaStore left
    // unset) nothing to consume post-response either. Quota-exempt
    // admissions (zero-work batches) skip for the same mechanical reason:
    // nothing executed, nothing billable.
    if (
      !options.bypassRateLimit &&
      !batchChildBilled &&
      !options.quotaExempt &&
      route !== undefined &&
      operation !== undefined &&
      !QUOTA_FREE_ROUTES.has(route)
    ) {
      try {
        quotaStore = providers.quotaStore ?? (await getQuotaStore());
        quotaCheck = await checkAllowance(quotaStore, {
          identity: principal,
          tier: ctx.tier,
          cost: operationCost,
          nowMs,
        });
      } catch (err) {
        safe(() =>
          observability.captureError(scrubError(err), {
            requestId: ctx.requestId,
          }),
        );
        span.recordError(scrubError(err));
        span.end();
        return errorResponse(ctx.requestId, {
          code: "service_unavailable",
          message: "Quota accounting unavailable.",
          hint: "Retry shortly; the request was not served without allowance accounting.",
          status: 503,
          origin,
        });
      }
      if (!quotaCheck.allowed) {
        // Rejected WITHOUT consuming: the ledger learns via a `rejected`
        // usage event (best-effort, same bound as the accounting stage);
        // the store total is untouched.
        const outcome = quotaCheck;
        safe(() =>
          usage.record({
            requestId: ctx.requestId,
            route,
            operation,
            cost: operationCost,
            policyVersion: operationPolicyVersion,
            outcome: "rejected",
            principal,
            tier: ctx.tier,
            windowId: outcome.windowId,
            resetMs: outcome.resetMs,
            allowance: outcome.allowance,
            // Phase 16: a quota-rejected batch still emits its single row
            // (summed cost + child summary), marked rejected.
            ...(options.usageChildren !== undefined
              ? { children: options.usageChildren }
              : {}),
          }),
        );
        span.end();
        // Phase 17: each quota-exhausted outcome is one empty-window
        // observation on the request's monthly window (×3 DISTINCT windows
        // → downgrade); the 429 below is already shaped.
        const abuseVerdict = await observeAbuseOutcome(
          ctx,
          route,
          "quota_exhausted",
          {
            quotaWindowId: outcome.windowId,
            clerk: providers.abuseClerk,
            keys: providers.abuseKeys,
          },
        );
        const retryAfter = Math.max(
          1,
          Math.ceil((outcome.resetMs - nowMs) / 1000),
        );
        const resetDay = new Date(outcome.resetMs).toISOString().slice(0, 10);
        let res = errorResponse(ctx.requestId, {
          code: "quota_exceeded",
          message: "Monthly quota exhausted.",
          hint: `Monthly credit allowance exhausted; new credits on ${resetDay} — reduce usage or wait for reset.`,
          status: 429,
          retryAfter,
          origin,
        });
        stampRateLimitHeaders(res, ctx, decision, origin);
        if (abuseVerdict === "warn") {
          res = await withAbuseWarn(
            res,
            "Repeated quota exhaustion flagged by abuse controls; reduce usage or wait for reset.",
          );
        }
        return res;
      }
    }

    let res: NextResponse;
    // Batch-only internal signal: any failed child degrades the usage row
    // to `partial` (telemetry history only — the quota charge already
    // landed via the store, which keys on `accepted` rows it writes
    // itself). Read from the handler-built response, then strip so the
    // wire contract stays byte-identical.
    let batchPartial = false;
    try {
      res = await handler(req, ctx);
      if (res.headers.get(BATCH_PARTIAL_HEADER) === "1") {
        batchPartial = true;
        res.headers.delete(BATCH_PARTIAL_HEADER);
      }
      // Phase 17: feed in-pipeline error/timeout responses back to the
      // abuse counters (400 → validation spam, 401 → auth failure, 504 →
      // timeout churn; 403 scope denials are never counted). The response is
      // already built; enforcement on a revoke-level verdict is awaited
      // inside the fail-fast budget, and a warn stamps Retry-After:60 +
      // warnings[] per the Phase 17 table. Batch preflight rejects never
      // reach here (they return before admission), so the batch route counts
      // those itself as `batch_rejected`.
      const abuseVerdict = await observeAbuseResponseStatus(
        ctx,
        route,
        res.status,
        {
          clerk: providers.abuseClerk,
          keys: providers.abuseKeys,
        },
      );
      if (abuseVerdict === "warn") {
        res = await withAbuseWarn(
          res,
          "Repeated rejected requests flagged by abuse controls; fix the request shape and retry after the time in Retry-After.",
        );
      }
    } catch (err) {
      // Phase 17: a fail-fast timeout escaping the handler is timeout
      // churn; any other throw is our own crash, never the caller's abuse
      // signal (and is never charged — see below). The verdict is kept so a
      // warn stamps Retry-After:60 + warnings[] on the 500 below (same
      // additive treatment as every other warn path).
      let timeoutVerdict: AbuseVerdict = "ok";
      if (
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        timeoutVerdict = await observeAbuseOutcome(ctx, route, "timeout", {
          clerk: providers.abuseClerk,
          keys: providers.abuseKeys,
        });
      }
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
      // No consumption on throw: the peek above never writes, and this path
      // returns before the consume step — our crash is never the caller's
      // charge.
      if (timeoutVerdict === "warn") {
        return withAbuseWarn(
          res,
          "Upstream timeout retries flagged by abuse controls; back off and retry later — this signal never revokes.",
        );
      }
      return res;
    }

    // Consume step: the handler produced a response (success OR error
    // status), so the admitted attempt is charged now. The billing key is
    // minted FRESH per admitted attempt (never ctx.requestId — that id
    // echoes caller-supplied X-Request-Id, so keying charges on it would
    // let one replayed id suppress charges for distinct executions). The
    // tracing request id still rides along for correlation. A failing
    // store fails closed with 503 rather than serving unaccounted work.
    if (
      quotaStore !== undefined &&
      quotaCheck !== undefined &&
      route !== undefined &&
      operation !== undefined
    ) {
      try {
        const { used } = await recordConsumption(quotaStore, {
          identity: principal,
          tier: ctx.tier,
          windowId: quotaCheck.windowId,
          cost: operationCost,
          operation,
          policyVersion: operationPolicyVersion,
          requestId: ctx.requestId,
          billingKey: idempotencyKey(),
        });
        quotaDecision = {
          allowed: true,
          used,
          remaining: Math.max(0, quotaCheck.allowance - used),
          allowance: quotaCheck.allowance,
          windowId: quotaCheck.windowId,
          resetMs: quotaCheck.resetMs,
          operation,
          policyVersion: operationPolicyVersion,
          tier: ctx.tier,
        };
        // Phase 17: a successful consume proves allowance remains — clear
        // this principal's quota-empty streak (best-effort, never throws).
        // Keyed on the QUOTA OWNER (identical to the store key above), never
        // the key-attributed abuse principal — so a sibling key's consume
        // resets the owner's streak (see `abuseCountingPrincipal`).
        safe(() =>
          noteAbuseOutcome({
            principal: quotaPrincipal(ctx),
            route,
            outcome: "quota_consumed",
          }),
        );
      } catch (err) {
        safe(() =>
          observability.captureError(scrubError(err), {
            requestId: ctx.requestId,
          }),
        );
        // The handler already produced a response, but it can never be
        // served: without a recorded charge it would be unaccounted work,
        // so fail-closed accounting drops it for this typed 503 instead.
        safe(() =>
          observability.log(
            "warn",
            "quota consume failed; handler response dropped",
            {
              requestId: ctx.requestId,
              route: route ?? "unknown",
              status: res.status,
            },
          ),
        );
        span.recordError(scrubError(err));
        span.end();
        return errorResponse(ctx.requestId, {
          code: "service_unavailable",
          message: "Quota accounting unavailable.",
          hint: "Retry shortly; the request was not served without allowance accounting.",
          status: 503,
          origin,
        });
      }
    }

    stampRateLimitHeaders(res, ctx, decision, origin);

    // Accounting stage (Phase 01: no-op recorder). Best-effort and bounded:
    // recorder invocation is dispatched in a later macrotask so it runs
    // after the route response is delivered, then raced against
    // ACCOUNTING_TIMEOUT_MS; a hung recorder observes an abort via its
    // optional signal, and timeouts/failures vanish through safe().
    // (Nodejs runtime, so setTimeout is always available.)
    // NOTE: the deferred work here is usage TELEMETRY only — the quota
    // charge above already completed synchronously in-request, so a dropped
    // macrotask loses at most an observability event, never a charge (Phase
    // 15 separation). No waitUntil is threaded through by design: that would
    // need new runtime plumbing for zero accounting gain. Verified batch
    // children record nothing — the parent emits the fan-out's single row,
    // never one row per child.
    if (!batchChildBilled) {
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
              quotaDecision,
              nowMs,
              // Phase 16: the admitted batch emits ONE row with its summed
              // cost + child summary (operation/policyVersion still catalog).
              // Quota-exempt (zero-work) admissions stamp cost 0 — admitted
              // and throttled, but nothing consumed.
              {
                cost: options.quotaExempt
                  ? 0
                  : options.costOverride === undefined
                    ? undefined
                    : operationCost,
                children: options.usageChildren,
                partial: batchPartial,
              },
            ),
            accountingTimeout(controller),
          ]);
        });
      }, 0);
    }

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
  quota?: QuotaDecision | undefined,
  nowMs: number = Date.now(),
  accounting?: {
    cost?: number;
    children?: UsageChildCost[];
    partial?: boolean;
  },
): Promise<void> | void {
  // Phase 13: credit rows stamp the resolved catalog record, and the QUOTA
  // policy version is authoritative for them (not the entitlements
  // snapshot). An unlabeled call keeps the legacy unknown/1 stub.
  // Phase 14: every row also carries tier + monthly window + allowance so
  // the ledger can explain balances without re-deriving policy. The window
  // derives from the request's single `nowMs` (never a fresh clock), and
  // the principal is the quota principal — identical to the store key.
  // A 200 envelope with failed children is partial success, not full:
  // batch rows then carry `partial` (history only — balances sum the
  // store-written `accepted` rows, never these telemetry rows).
  const outcome = !ok
    ? "rejected"
    : accounting?.partial
      ? "partial"
      : "accepted";
  const principal = quotaPrincipal(ctx);
  const window = quota
    ? { windowId: quota.windowId, resetMs: quota.resetMs }
    : quotaWindowFor(nowMs);
  const allowance = quota?.allowance ?? allowanceForTier(ctx.tier);
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
        tier: ctx.tier,
        windowId: window.windowId,
        resetMs: window.resetMs,
        allowance,
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
    // Phase 16: a per-request cost override (batch summed total) replaces
    // the static label cost on this single row.
    cost = accounting?.cost ?? resolved.cost;
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
        // Route labels are internal constants, not secrets — safe to log;
        // the message itself stays static/scrubbed.
        { requestId: ctx.requestId, route },
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
      tier: ctx.tier,
      windowId: window.windowId,
      resetMs: window.resetMs,
      allowance,
      // Phase 16: one batch row carries its priced-child summary (child
      // count + per-child costs), never one row per child.
      ...(accounting?.children !== undefined
        ? { children: accounting.children }
        : {}),
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

/**
 * Phase 17 abuse principal: key-first, never owner-first. An `api_key`
 * caller carries both `keyId` and a subject `userId`, but its failures must
 * pool under the KEY identity — pooling under `user:` would attribute one
 * key's abuse to the owner (punishing their other keys/sessions) and route
 * revoke at a session the key never had, leaving the abusive key usable.
 * Key verdicts revoke/suspend the KEY via `apiKeys.revoke`, never the
 * owner's sessions.
 */
function abusePrincipal(ctx: RequestContext): string {
  const keyId = ctx.auth.keyId;
  if (typeof keyId === "string" && keyId !== "") {
    return `key:${keyId}`;
  }
  return ctx.rateLimitIdentity;
}

/**
 * Phase 17 counting principal: quota outcomes key on the QUOTA OWNER while
 * everything else stays key-attributed. Quota is per-account — the store
 * key IS `quotaPrincipal(ctx)` (`user:` owner for key callers carrying a
 * subject) — so the quota-empty streak and its consume-reset must use that
 * same owner identity: per-`key:` streaks would splinter one account's
 * drought (downgrading past a single key's rung while the shared bucket
 * stays empty) and a sibling key's consume would never reset the streak.
 * Rate/auth/validation/timeout/batch abuse stays on `abusePrincipal`
 * (key-first): one key's failures must never pool under the owner's user
 * identity.
 */
function abuseCountingPrincipal(
  ctx: RequestContext,
  outcome: AbuseOutcome,
): string {
  return outcome === "quota_exhausted" || outcome === "quota_consumed"
    ? quotaPrincipal(ctx)
    : abusePrincipal(ctx);
}

interface AbuseObserveDeps {
  quotaWindowId?: string;
  clerk?: ClerkAdminClient;
  keys?: ApiKeysClient;
}

/**
 * Phase 17 abuse observation: forward an already-computed pipeline outcome
 * to the abuse counters and AWAIT enforcement on revoke-level verdicts.
 * Awaiting (instead of fire-and-forget) keeps enforcement alive on
 * serverless runtimes that freeze detached work after the response; it
 * stays p95-safe because only rare threshold-crossing requests perform a
 * Clerk call (ok/warn verdicts return after in-memory counting only), every
 * call runs inside the 8s fail-fast budget, and enforcement never throws
 * (failures degrade to audit + metric). `key:` principals carry their
 * subject as `targetUserId` so downgrade can resolve an attributable user,
 * but their revoke path touches only the key — never the owner's sessions.
 * Returns the verdict so callers can stamp warn signals on the response.
 */
async function observeAbuseOutcome(
  ctx: RequestContext,
  route: string | undefined,
  outcome: AbuseOutcome,
  deps: AbuseObserveDeps = {},
): Promise<AbuseVerdict> {
  // Quota outcomes count on the quota owner; everything else on the
  // key-attributed abuse principal (see `abuseCountingPrincipal`).
  const principal = abuseCountingPrincipal(ctx, outcome);
  const keySubject =
    principal.startsWith("key:") &&
    ctx.auth.userId !== undefined &&
    ctx.auth.userId !== ""
      ? ctx.auth.userId
      : undefined;
  let verdict: AbuseVerdict = "ok";
  try {
    // No `targetUserId` here: warn/ban audit rows must name the key itself
    // (`key:…`), never the owner's subject — the subject is threaded only
    // into downgrade enforcement below, where it resolves the user to step.
    verdict = noteAbuseOutcome({
      principal,
      route,
      outcome,
      requestId: ctx.requestId,
      ...(deps.quotaWindowId !== undefined
        ? { quotaWindowId: deps.quotaWindowId }
        : {}),
    });
  } catch {
    return "ok";
  }
  if (verdict === "revoke" || verdict === "downgrade") {
    try {
      await enforceAbuseVerdict({
        verdict,
        principal,
        requestId: ctx.requestId,
        reason: `abuse:${outcome} threshold reached; automatic ${verdict} per abuse controls.`,
        // Sessions revoke only for `user:` principals; key abuse revokes
        // the key (see `abusePrincipal`), never the owner's sessions.
        ...(principal.startsWith("user:") &&
        ctx.auth.sessionId !== undefined &&
        ctx.auth.sessionId !== ""
          ? { sessionId: ctx.auth.sessionId }
          : {}),
        // Subject threading is downgrade-only: a key revoke audits against
        // the key reference, never the owner's user id.
        ...(keySubject !== undefined && verdict === "downgrade"
          ? { targetUserId: keySubject }
          : {}),
        ...(deps.clerk !== undefined ? { clerk: deps.clerk } : {}),
        ...(deps.keys !== undefined ? { keys: deps.keys } : {}),
        signal: AbortSignal.timeout(ABUSE_ENFORCE_TIMEOUT_MS),
      });
    } catch {
      // Intentionally ignored — enforcement must never break a response.
    }
  }
  return verdict;
}

/**
 * Phase 17 status-to-signal mapping for handler-built responses: 400s are
 * validation spam, 401s are auth failures, 504s are timeout churn.
 * 403s are scope/permission denials — authorization outcomes, NOT
 * credential failures — and are deliberately never counted (counting them
 * as `auth_failure` would revoke callers for permission denials).
 * Handler-thrown fail-fast timeouts map separately at the throw site
 * above. Never throws; unknown statuses resolve `ok`.
 */
async function observeAbuseResponseStatus(
  ctx: RequestContext,
  route: string | undefined,
  status: number,
  deps: AbuseObserveDeps = {},
): Promise<AbuseVerdict> {
  if (status === 400) {
    return observeAbuseOutcome(ctx, route, "validation_error", deps);
  }
  if (status === 401) {
    return observeAbuseOutcome(ctx, route, "auth_failure", deps);
  }
  if (status === 504) {
    return observeAbuseOutcome(ctx, route, "timeout", deps);
  }
  return "ok";
}

/**
 * Phase 17 warn stamping: a `warn` verdict adds `Retry-After: 60` (when the
 * response lacks one — 429s already carry their own) plus a `warnings[]`
 * entry naming the abuse control. Only additive, never throws, and a body
 * that is not a JSON object (or already carries `warnings`) is returned
 * untouched — warn changes no decision, it only advises the caller.
 */
async function withAbuseWarn(
  res: NextResponse,
  message: string,
): Promise<NextResponse> {
  try {
    if (!res.headers.get("Retry-After")) {
      res.headers.set("Retry-After", "60");
    }
    const body: unknown = await res
      .clone()
      .text()
      .then(
        (text) => JSON.parse(text) as unknown,
        () => undefined,
      );
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).warnings !== undefined
    ) {
      return res;
    }
    return new NextResponse(
      JSON.stringify({
        ...(body as Record<string, unknown>),
        warnings: [{ code: "abuse_warned", message }],
      }),
      { status: res.status, headers: res.headers },
    );
  } catch {
    return res;
  }
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
