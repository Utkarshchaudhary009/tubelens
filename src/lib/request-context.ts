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
 * Build a RequestContext for an incoming request. Pure factory: callers
 * pass the already-resolved auth/tier pieces (see createRequestContext in
 * ./pipeline for the provider-wired version). The traceId defaults to the
 * requestId; span placeholders arrive with real tracing in Phase 18.
 */
export function buildRequestContext(
  req: NextRequest | Request,
  inputs: ContextInputs,
): RequestContext {
  const headerId =
    req.headers.get("x-request-id") ?? req.headers.get("X-Request-Id") ?? null;
  const requestId =
    headerId && headerId.trim() !== "" ? headerId : mintRequestId();
  const rateLimitIdentity = deriveRateLimitIdentity(req, inputs.auth);
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

function mintRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Best-effort rate-limit identity: authenticated user > api key > caller
 * IP placeholder. IP extraction stays coarse in Phase 01 (no proxy-trust
 * chain yet); the Redis engine in Phase 12 refines dimensions.
 */
function deriveRateLimitIdentity(
  req: NextRequest | Request,
  auth: AuthContext,
): string {
  if (auth.userId) {
    return `user:${auth.userId}`;
  }
  if (auth.keyId) {
    return `key:${auth.keyId}`;
  }
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `anon:${ip}`;
}
