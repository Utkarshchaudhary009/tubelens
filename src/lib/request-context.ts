// Canonical per-request context shared by every /api/v1 route (Phase 01).
// Later phases fill the placeholder fields (real Clerk principal in Phase
// 02, project/key identity in Phases 05–07); the shape stays stable so
// routes written against it do not churn.

import type { NextRequest } from "next/server";
import type { AuthContext } from "./auth";
import type { EntitlementSnapshot, Tier } from "./product";

export interface RequestContext {
  /** Echoed X-Request-Id when the caller sends one, otherwise minted. */
  requestId: string;
  /** Trace correlation id — equals requestId until real tracing (Ph. 18). */
  traceId: string;
  /** Authenticated principal; anonymous by default in Phase 01. */
  auth: AuthContext;
  /** Project/key identity; unknown until machine auth (Phase 05+). */
  projectId?: string;
  keyId?: string;
  /** Effective tier; always `free` in Phase 01. */
  tier: Tier;
  /** Minimal entitlement snapshot derived from the tier. */
  entitlements: EntitlementSnapshot;
  /** Identity the rate limiter keys on (anon IP, user, or key). */
  rateLimitIdentity: string;
  /** Route/tool name for logs, metrics, and usage events. */
  route?: string;
  /** Milliseconds since epoch when the context was created. */
  startedAt: number;
}

export interface ContextInputs {
  auth: AuthContext;
  tier: Tier;
  entitlements: EntitlementSnapshot;
  route?: string;
}

/**
 * Caller-supplied ids must be short opaque tokens; anything else is
 * minted. (Headers.get is case-insensitive, so one lookup covers all
 * casings of X-Request-Id.)
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-_:.]{1,128}$/;

/**
 * Resolve the request id: echo a valid caller-supplied X-Request-Id
 * (trimmed first), otherwise mint a UUID. Validation keeps oversized or
 * exotic values from flowing into logs, cache keys, and traces.
 */
export function resolveRequestId(req: NextRequest | Request): string {
  const raw = req.headers.get("x-request-id");
  const id = (raw ?? "").trim();
  return REQUEST_ID_PATTERN.test(id) ? id : crypto.randomUUID();
}

/**
 * Build a RequestContext for an incoming request. Pure factory: callers
 * pass the already-resolved auth/tier pieces (see createRequestContext in
 * ./pipeline for the provider-wired version). The traceId defaults to the
 * requestId; span placeholders arrive with real tracing in Phase 18.
 */
export function buildRequestContext(
  req: NextRequest | Request,
  inputs: ContextInputs,
): RequestContext {
  const requestId = resolveRequestId(req);
  const rateLimitIdentity = deriveRateLimitIdentity(inputs.auth);
  return {
    requestId,
    traceId: requestId,
    auth: inputs.auth,
    projectId: inputs.auth.projectId,
    keyId: inputs.auth.keyId,
    tier: inputs.tier,
    entitlements: inputs.entitlements,
    rateLimitIdentity,
    route: inputs.route,
    startedAt: Date.now(),
  };
}

/**
 * Rate-limit identity: authenticated user > api key > stable anonymous key.
 * Anonymous callers deliberately share one key: X-Forwarded-For is
 * attacker-rotatable, so trusting it would let a caller mint unlimited
 * limiter buckets. Trade-off: one shared "anonymous" bucket means a burst
 * from one anonymous client counts against all of them — per-IP anonymous
 * buckets require trusted-ingress configuration and land with the
 * distributed limiter in Phase 12. Until then the allow-all default means
 * no bucket exhaustion is possible, so sharing is safe and no X-Forwarded-
 * For trust is introduced here.
 */
function deriveRateLimitIdentity(auth: AuthContext): string {
  if (auth.userId) {
    return `user:${auth.userId}`;
  }
  if (auth.keyId) {
    return `key:${auth.keyId}`;
  }
  return "anonymous";
}
