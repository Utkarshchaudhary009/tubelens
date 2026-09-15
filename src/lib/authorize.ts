// Phase 07 (Part B): explicit authorization matrix + ownership helpers.
//
// Pure and server-only-safe: this module holds no secrets, performs no I/O,
// and never throws — denials are returned as typed decisions the handler
// maps through `errorResponse()`. It deliberately avoids
// `import "server-only"` (that package throws unconditionally under bun,
// which would make this module untestable — same rationale as
// `clerk-auth.ts`); the no-client guarantee comes from the import graph
// (API-only repo, Route Handlers only).
//
// Principal model (see `auth.ts`): `anonymous` (signed out), `user`
// (interactive Clerk session), `api_key` (Phase 05 machine credential).
// Roles (`admin` / `support` / `user`) ride on the user principal's
// claim-projected `role`; `api_key` principals carry no role and can never
// administer (defense in depth beyond `requireAdmin`'s type check).
//
// Support policy (explicit): `support` is READ-ONLY. A support caller may
// list key metadata (`keys:list`) but may NOT issue keys, revoke keys, or
// mutate tier/role (`keys:issue`, `keys:revoke`, `users:mutate-tier`,
// `users:mutate-role` → 403). The current admin key routes conservatively
// require `admin` for listing too (Phase 05 contract); the matrix allow for
// support listing is the policy floor a future support-scoped list endpoint
// can adopt — routes stay fail-closed until then.
//
// Projects/orgs: no projects/orgs tables exist yet, so `AuthContext.projectId`
// is never populated. Any resource carrying a `projectId` therefore fails
// closed for non-admins (a credential can never prove membership of a
// project it cannot name); admins bypass. When projects land, populating
// `ctx.projectId` activates the membership check with no matrix change.

import { normalizeRole } from "./admin-guard";
import type { AuthContext } from "./auth";
import { errorResponse } from "./errors";

/** Sensitive actions gated by this matrix. Unknown/future action strings
 * are accepted by the type but always denied (fail closed). */
export const AUTHORIZE_ACTIONS = [
  "read:public",
  "read:self",
  "keys:list",
  "keys:issue",
  "keys:revoke",
  "users:mutate-tier",
  "users:mutate-role",
] as const;

export type KnownAuthorizeAction = (typeof AUTHORIZE_ACTIONS)[number];

/** Known actions plus any future string — the matrix denies what it does
 * not recognize, so callers never need a schema change to stay safe. */
export type AuthorizeAction = KnownAuthorizeAction | (string & {});

/** Ownership anchor for a resource lookup. Every lookup must be scoped to
 * one of these; a missing anchor fails closed. */
export interface AuthorizeResource {
  /** Owning Clerk user id (`user_xxx`) — the horizontal boundary. */
  ownerUserId?: string;
  /** Owning project/environment label — the cross-project boundary.
   * Never populated on contexts yet (no projects tables), so any resource
   * carrying one denies non-admins until projects exist. */
  projectId?: string;
}

export type AuthorizationDenialCode = "unauthenticated" | "forbidden";

export type AuthorizeDecision =
  | { ok: true }
  | {
      ok: false;
      code: AuthorizationDenialCode;
      status: 401 | 403;
      message: string;
      hint: string;
    };

export interface AuthorizeArgs {
  action: AuthorizeAction;
  ctx: AuthContext;
  resource?: AuthorizeResource;
}

/** True for user principals whose claim-projected role is `admin`.
 * `api_key` principals are never admins (no role rides on a key), even
 * when the key's subject is an admin user. */
export function isAdminPrincipal(ctx: AuthContext): boolean {
  return (
    ctx.authenticated &&
    ctx.type === "user" &&
    typeof ctx.userId === "string" &&
    ctx.userId !== "" &&
    normalizeRole(ctx.role) === "admin"
  );
}

/** True for user principals whose claim-projected role is `support`. */
export function isSupportPrincipal(ctx: AuthContext): boolean {
  return (
    ctx.authenticated &&
    ctx.type === "user" &&
    typeof ctx.userId === "string" &&
    ctx.userId !== "" &&
    normalizeRole(ctx.role) === "support"
  );
}

/** 401 for anonymous callers, 403 for authenticated-but-unauthorized ones.
 * Never throws. */
function denied(
  ctx: AuthContext,
  message: string,
  hint: string,
): Extract<AuthorizeDecision, { ok: false }> {
  if (!ctx.authenticated) {
    return {
      ok: false,
      code: "unauthenticated",
      status: 401,
      message: "Authentication is required.",
      hint: "Sign in and retry with a valid session or API key; anonymous callers cannot perform this action.",
    };
  }
  return { ok: false, code: "forbidden", status: 403, message, hint };
}

/**
 * Project scoping (vertical boundary): when the resource names a project,
 * the caller must prove membership via `ctx.projectId` — which is never
 * populated yet, so non-admins fail closed. Admins bypass (operator
 * visibility). Returns a denial, or undefined when the check passes (or
 * does not apply because the resource names no project).
 */
function checkProjectScope(
  ctx: AuthContext,
  resource: AuthorizeResource | undefined,
): Extract<AuthorizeDecision, { ok: false }> | undefined {
  const projectId = resource?.projectId;
  if (projectId === undefined) {
    return undefined;
  }
  if (isAdminPrincipal(ctx)) {
    return undefined;
  }
  if (ctx.projectId !== undefined && ctx.projectId === projectId) {
    return undefined;
  }
  return denied(
    ctx,
    "Credential is not bound to this project.",
    "Retry with a credential issued for the resource's project; credentials from another project are denied.",
  );
}

/**
 * Explicit authorization matrix. Pure, never throws, deny-by-default:
 * - `read:public` — every principal, including anonymous.
 * - `read:self` — the owner (`ctx.userId === resource.ownerUserId`) or an
 *   admin; cross-user access → 403.
 * - `keys:list` — admin, plus read-only `support`; non-admin users and
 *   `api_key` principals → 403.
 * - `keys:issue` / `keys:revoke` / `users:mutate-tier` /
 *   `users:mutate-role` — admin only. `support` → 403 (read-only), `api_key`
 *   → 403 (keys can never administer), anonymous → 401.
 * - anything else (unknown/future action) — denied, closed.
 *
 * Project scoping above applies to every action naming a `projectId`.
 */
export function can(args: AuthorizeArgs): AuthorizeDecision {
  const { action, ctx, resource } = args;
  const scoped = checkProjectScope(ctx, resource);
  if (scoped) {
    return scoped;
  }
  switch (action) {
    case "read:public": {
      return { ok: true };
    }
    case "read:self": {
      const owner = resource?.ownerUserId;
      if (typeof owner !== "string" || owner === "") {
        return denied(
          ctx,
          "Resource owner is unknown.",
          "Retry with the resource's owning user id; lookups without an owner are denied.",
        );
      }
      if (isAdminPrincipal(ctx)) {
        return { ok: true };
      }
      if (
        ctx.authenticated &&
        typeof ctx.userId === "string" &&
        ctx.userId === owner
      ) {
        return { ok: true };
      }
      return denied(
        ctx,
        "Cross-user access denied.",
        "Retry with the owning user's credential; resources are visible only to their owner or an admin.",
      );
    }
    case "keys:list": {
      if (isAdminPrincipal(ctx) || isSupportPrincipal(ctx)) {
        return { ok: true };
      }
      return denied(
        ctx,
        "Key metadata listing denied.",
        "Retry as an admin or support caller; other principals cannot list another subject's keys.",
      );
    }
    case "keys:issue":
    case "keys:revoke":
    case "users:mutate-tier":
    case "users:mutate-role": {
      if (isAdminPrincipal(ctx)) {
        return { ok: true };
      }
      if (isSupportPrincipal(ctx)) {
        return denied(
          ctx,
          "Support callers are read-only.",
          "Support may list key metadata but cannot issue/revoke keys or mutate tier/role; ask an admin.",
        );
      }
      if (ctx.authenticated && ctx.type === "api_key") {
        return denied(
          ctx,
          "API keys cannot administer.",
          "API keys never carry admin rights, even for an admin subject; retry with an admin user session.",
        );
      }
      return denied(
        ctx,
        "Admin access required.",
        "Sign in as an admin user; non-admin callers cannot perform this action.",
      );
    }
    default: {
      // Unknown/future action: fail closed. No allowlist entry means no
      // access, regardless of how privileged the caller looks.
      return denied(
        ctx,
        "Unknown action denied.",
        "The requested action is not recognized, so it is denied by default; contact support if this action should exist.",
      );
    }
  }
}

/**
 * Ownership gate for resource handlers (horizontal boundary + admin
 * bypass). Delegates to `can({ action: "read:self", ... })`: the owner or
 * an admin is allowed; User B with User A's id → 403; anonymous → 401.
 * Returns (never throws): map a denial with `toAuthorizationResponse()`.
 */
export function requireOwnerOrAdmin(
  ctx: AuthContext,
  ownerUserId: string,
): AuthorizeDecision {
  return can({ action: "read:self", ctx, resource: { ownerUserId } });
}

/**
 * Scope strings that name a privileged matrix action. A key carrying one of
 * these strings is NOT thereby authorized for the action — `requireScope`
 * consults `can()` for the mapped action first, and `can()` denies every
 * `api_key` administration regardless of scope strings (keys can never
 * admin). Without this map, an authority-minted scope like
 * `users:mutate-role` would pass a pure membership check and contradict the
 * matrix. Non-privileged scopes (e.g. `search:read`, `write:comments`) use
 * membership alone.
 */
const PRIVILEGED_SCOPE_ACTIONS: Record<string, AuthorizeAction> = {
  "keys:list": "keys:list",
  "keys:issue": "keys:issue",
  "keys:revoke": "keys:revoke",
  "users:mutate-tier": "users:mutate-tier",
  "users:mutate-role": "users:mutate-role",
  "read:self": "read:self",
};

/**
 * Scope gate for `api_key` principals (future write scopes). Admin user
 * sessions are not scope-bound and always pass. An `api_key` principal
 * passes only when the matrix allows the mapped action (for scope strings
 * naming a privileged action — `can()` denies all key administration, so a
 * privileged scope string alone never authorizes) AND its projected
 * `scopes` (see `auth.ts`) include the required scope. Session users
 * without admin rights and anonymous callers are denied.
 * Returns (never throws).
 */
export function requireScope(
  ctx: AuthContext,
  scope: string,
  resource?: AuthorizeResource,
): AuthorizeDecision {
  if (isAdminPrincipal(ctx)) {
    return { ok: true };
  }
  if (ctx.authenticated && ctx.type === "api_key") {
    // Own-key check: inherited properties (e.g. "constructor") must not be
    // treated as privileged actions.
    const mapped = Object.hasOwn(PRIVILEGED_SCOPE_ACTIONS, scope)
      ? PRIVILEGED_SCOPE_ACTIONS[scope]
      : undefined;
    if (mapped !== undefined) {
      const decision = can({ action: mapped, ctx, resource });
      if (!decision.ok) {
        return decision;
      }
    }
    if (Array.isArray(ctx.scopes) && ctx.scopes.includes(scope)) {
      return { ok: true };
    }
    return denied(
      ctx,
      "API key lacks the required scope.",
      `Retry with a key granted the "${scope}" scope; keys without it are denied.`,
    );
  }
  return denied(
    ctx,
    "Scope check denied.",
    "Retry with an admin user session or an API key granted the required scope.",
  );
}

/**
 * Map a matrix denial to the typed error body via `errorResponse()`
 * (never a bare 500, never throws). Returns undefined when allowed, so
 * handlers keep the familiar guard shape:
 *   const denied = toAuthorizationResponse(requestId, can({...}));
 *   if (denied) return denied;
 */
export function toAuthorizationResponse(
  requestId: string,
  decision: AuthorizeDecision,
): ReturnType<typeof errorResponse> | undefined {
  if (decision.ok) {
    return undefined;
  }
  return errorResponse(requestId, {
    code: decision.code,
    message: decision.message,
    hint: decision.hint,
    status: decision.status,
  });
}
