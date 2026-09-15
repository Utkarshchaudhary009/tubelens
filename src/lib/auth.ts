// Phase 01 platform boundary: authentication provider seam.
//
// `AuthProvider` is the stable interface behind which all identity logic
// lives. Phase 01 ships only the anonymous default (no Clerk SDK — that
// lands here in Phase 02). Routes must depend on this interface, never on
// provider-specific imports.

import type { NextResponse } from "next/server";
import { errorResponse } from "./errors";
import type { Tier } from "./product";

// Canonical re-export (PLANS_AND_USAGE.md §16): REST handlers and future
// MCP tools import `getEffectiveTier` from this module. The implementation
// stays in `./product`; this is a type-plus-value re-export with no logic.
// No cycle risk: `./product` imports nothing from this module, and the
// `Tier` import above is type-only (erased at runtime).
export { getEffectiveTier } from "./product";

export type AuthPrincipalType = "anonymous" | "user" | "api_key";

export interface AuthContext {
  type: AuthPrincipalType;
  /** True for the anonymous default; false once a real principal exists. */
  authenticated: boolean;
  /** Clerk user id once Phase 02 lands; absent for anonymous. */
  userId?: string;
  /**
   * Claim-projected tier (Phase 03): `clerkAuthProvider` normalizes the
   * `tubelens.tier` session claim here via `getEffectiveTier`. Absent for
   * anonymous/legacy contexts — the pipeline's policy provider falls back
   * to `free`. Fast but ~60s-stale; write paths must re-fetch authoritative
   * Clerk metadata (Phase 04), never trust this alone.
   */
  tier?: Tier;
  /**
   * Claim-projected role (Phase 04): `clerkAuthProvider` normalizes the
   * `metadata.role` session claim here via `getEffectiveRole`.
   * Missing/invalid → `user` (least privilege, never self-escalating).
   * Fast but ~60s-stale; admin write paths must re-fetch authoritative
   * Clerk metadata (Phase 04), never trust this alone.
   */
  role?: string;
  /** Clerk key reference once Phase 05 lands; never a plaintext secret. */
  keyId?: string;
  /** Owning project/environment label once projects exist (Phase 07+). */
  projectId?: string;
}

export interface AuthProvider {
  /** Resolve the caller principal for this request. Must never throw for
   * anonymous callers — return the anonymous context instead. */
  resolve(req: Request): Promise<AuthContext> | AuthContext;
}

export const anonymousAuthContext: AuthContext = Object.freeze({
  type: "anonymous",
  authenticated: false,
});

/** Phase 01 default: every request is anonymous. */
export const anonymousAuthProvider: AuthProvider = Object.freeze({
  resolve(): AuthContext {
    return { ...anonymousAuthContext };
  },
});

let current: AuthProvider = anonymousAuthProvider;

/** Swap the active provider (used by later phases and by tests). */
export function setAuthProvider(provider: AuthProvider): void {
  current = provider;
}

export function getAuthProvider(): AuthProvider {
  return current;
}

/** Reset to the Phase 01 anonymous default (primarily for tests). */
export function resetAuthProvider(): void {
  current = anonymousAuthProvider;
}

/**
 * Typed 401 JSON for unauthenticated callers. Machine-readable by design:
 * protected API routes must return this, never a browser redirect or 404.
 */
export function unauthenticatedResponse(requestId: string): NextResponse {
  return errorResponse(requestId, {
    code: "unauthenticated",
    message: "Authentication is required.",
    hint: "Sign in and retry with a valid session; anonymous callers cannot access this endpoint.",
    status: 401,
  });
}

/**
 * Gate for protected routes (Phase 02). Returns undefined when the context
 * carries an authenticated principal, otherwise the typed 401 response.
 *
 * Returns (never throws): the pipeline maps handler throws to 500, so a
 * throwing gate would mask 401s as 500s. Usage:
 *   const denied = requireAuth(ctx);
 *   if (denied) return denied;
 */
export function requireAuth(ctx: {
  auth: AuthContext;
  requestId: string;
}): NextResponse | undefined {
  if (ctx.auth.authenticated) {
    return undefined;
  }
  return unauthenticatedResponse(ctx.requestId);
}

export type {
  RequireAdminDenial,
  RequireAdminResult,
  RequireAdminSuccess,
  UserRole,
} from "./admin-guard";
// Phase 04 admin helpers live in `./admin-guard` (REST handlers first,
// future MCP tools later per PLANS_AND_USAGE.md §16); re-exported here so
// both surfaces share one module. `./admin-guard` imports this file
// type-only, so the re-export below is not a runtime cycle.
export {
  forbiddenResponse,
  getEffectiveRole,
  mapAdminBodyError,
  normalizeRole,
  requireAdmin,
  USER_ID_PATTERN,
  USER_ROLES,
} from "./admin-guard";
