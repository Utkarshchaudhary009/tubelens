// Phase 04 (Part B): tier/role administration helpers.
//
// Canonical keys (PLANS_AND_USAGE.md §2): authoritative state lives in Clerk
// user `publicMetadata` as exactly `{ tier, role }`. The session token only
// projects `tubelens.tier` + `metadata.role` as a fast, ~60s-stale claim
// (types/globals.d.ts CustomJwtSessionClaims) — hot read paths may use the
// claim, but admin write paths must re-fetch authoritative metadata via the
// `clerk-admin` seam, never trust a stale claim.
//
// This module is imported (re-exported) through `./auth` so REST handlers
// first and future MCP tools later share one gate (PLANS_AND_USAGE.md §16).
// It imports `./auth` type-only (erased at runtime) plus `./errors` for the
// 403 builder — no runtime cycle with `./auth`'s re-export below.

import type { AuthContext } from "./auth";
import { errorResponse } from "./errors";

/** Canonical roles, ranked by privilege. Orgs are not used — `role` is the admin signal. */
export const USER_ROLES = ["admin", "support", "user"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Target `:userId` shape; anything else is 400 `invalid_user_id`. */
export const USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

/**
 * Normalize an untrusted role value. Only the three canonical roles pass
 * through; missing/invalid values fall back to `user` (least privilege), so
 * a forged or absent claim can never self-escalate. Never throws.
 */
export function normalizeRole(raw: unknown): UserRole {
  return (USER_ROLES as readonly unknown[]).includes(raw)
    ? (raw as UserRole)
    : "user";
}

/**
 * Resolve the effective role from an untrusted Clerk session-claims object.
 * Reads `claims.metadata.role` (the `publicMetadata` projection minted by
 * the Dashboard session-token template) through `normalizeRole`:
 * missing/invalid values fall back to `user`. Never throws — malformed
 * input resolves `user`. Stale by ~60s: admin write paths must re-fetch
 * authoritative metadata instead of trusting this alone.
 */
export function getEffectiveRole(sessionClaims: unknown): UserRole {
  try {
    if (typeof sessionClaims !== "object" || sessionClaims === null) {
      return "user";
    }
    const metadata = (sessionClaims as { metadata?: unknown }).metadata;
    if (typeof metadata !== "object" || metadata === null) {
      return "user";
    }
    return normalizeRole((metadata as { role?: unknown }).role);
  } catch {
    return "user";
  }
}

export interface RequireAdminSuccess {
  ok: true;
  userId: string;
  role: "admin";
}

export interface RequireAdminDenial {
  ok: false;
  /** `unauthenticated` → 401, `forbidden` → 403 (mapped by the handler). */
  code: "unauthenticated" | "forbidden";
}

export type RequireAdminResult = RequireAdminSuccess | RequireAdminDenial;

/**
 * Admin gate for Route Handlers (never `auth.protect()` — it throws 404).
 * Returns (never throws): the handler maps a denial to `errorResponse()`.
 *
 * - Not signed in as a *user* principal (anonymous, signed-out, or a future
 *   api-key principal carrying no user identity) → 401 `unauthenticated`.
 * - Signed in but `publicMetadata.role !== "admin"` (claim-projected via
 *   `getEffectiveRole`, least-privilege fallback) → 403 `forbidden`.
 */
export function requireAdmin(auth: AuthContext): RequireAdminResult {
  if (
    !auth.authenticated ||
    auth.type !== "user" ||
    typeof auth.userId !== "string" ||
    auth.userId === ""
  ) {
    return { ok: false, code: "unauthenticated" };
  }
  if (normalizeRole(auth.role) !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  return { ok: true, userId: auth.userId, role: "admin" };
}

/** Typed 403 JSON for authenticated non-admin callers. */
export function forbiddenResponse(
  requestId: string,
  message = "Admin access required.",
  hint = "Sign in as an admin user; non-admin callers cannot change tiers or roles.",
): ReturnType<typeof errorResponse> {
  return errorResponse(requestId, {
    code: "forbidden",
    message,
    hint,
    status: 403,
  });
}

/** Minimal structural issue shape — zod issues satisfy this without importing zod here. */
export interface BodyIssue {
  path: readonly (string | number | symbol)[];
  code: string;
}

/**
 * Map strict-body zod issues to typed 400 codes (message + one-sentence
 * hint; the handler adds `status: 400` via `errorResponse()`):
 * - `<field>` enum violation → `invalid_tier` / `invalid_role` (never a
 *   generic message, so callers can distinguish bad values).
 * - `reason` violation (e.g. over 280 chars) → `invalid_reason`.
 * - smuggled/extra keys (`.strict()` unrecognized-keys) or anything else →
 *   `invalid_body`.
 */
export function mapAdminBodyError(
  field: "tier" | "role",
  issues: readonly BodyIssue[],
): { code: string; message: string; hint: string } {
  for (const issue of issues) {
    const head = issue.path[0];
    if (head === field) {
      return field === "tier"
        ? {
            code: "invalid_tier",
            message: "Invalid tier.",
            hint: "Use one of free, plus, pro, enterprise.",
          }
        : {
            code: "invalid_role",
            message: "Invalid role.",
            hint: "Use one of admin, support, user.",
          };
    }
    if (head === "reason") {
      return {
        code: "invalid_reason",
        message: "Invalid reason.",
        hint: "Keep reason to 280 characters or fewer, or omit it.",
      };
    }
  }
  return {
    code: "invalid_body",
    message: "Invalid request body.",
    hint:
      field === "tier"
        ? 'Send exactly { "tier": "free|plus|pro|enterprise" } with an optional 280-char reason; no other keys are accepted.'
        : 'Send exactly { "role": "admin|support|user" } with an optional 280-char reason; no other keys are accepted.',
  };
}
