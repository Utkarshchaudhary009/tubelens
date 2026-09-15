// Phase 02: Clerk-backed AuthProvider behind the Phase 01 auth seam.
//
// Server-side only by construction: this module is imported exclusively
// from Route Handlers (`runtime = "nodejs"`) and `src/proxy.ts` — never
// from client code — and it only ever reads CLERK_SECRET_KEY from
// process.env at request time (never returns, logs, or embeds it). It
// deliberately avoids `import "server-only"`: that package throws
// unconditionally under bun, which would make this provider untestable;
// the no-client guarantee comes from the import graph (API-only repo, no
// pages/components) plus the lazy Clerk import below.
//
// Route classification decision (Phase 02 — single source of truth for
// later phases):
// - public: every Part A read route + /health + /openapi.json. Anonymous
//   is fine; they run through the pipeline's default anonymous provider
//   with byte-identical behavior.
// - authenticated: /api/v1/me (this phase's proof endpoint). Future user
//   routes opt in the same way: `clerkAuthProvider` + `requireAuth()`.
// - machine (api-key): deferred to Phase 05 — no route carries it yet.

import { getEffectiveRole } from "./admin-guard";
import {
  type ApiKeysClient,
  getApiKeysClient,
  touchKeyLastUsed,
} from "./api-keys";
import type { AuthContext, AuthProvider } from "./auth";
import { anonymousAuthContext } from "./auth";
import { clerkErrorStatus } from "./clerk-admin";
import { getConfig } from "./config";
import { getEffectiveTier, normalizeTier, type Tier } from "./product";

/** Protected pathnames (exact match); everything else is public. */
export const AUTHENTICATED_ROUTES = ["/api/v1/me"] as const;

export type RouteAuthKind = "public" | "authenticated";

/** Classify a v1 pathname per the Phase 02 decision above. */
export function routeAuthKind(pathname: string): RouteAuthKind {
  return (AUTHENTICATED_ROUTES as readonly string[]).includes(pathname)
    ? "authenticated"
    : "public";
}

/**
 * Shared session-attach gate: both `src/proxy.ts` and this provider key on
 * the server secret alone. Deliberately NOT on
 * NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: that key is public client config, not a
 * server secret, and `getConfig` (pinned by Phase 01 tests) treats
 * required+secret-only as valid — requiring the publishable key server-side
 * would contradict that contract. A half-configured deploy (secret without
 * publishable key) therefore attempts attach and degrades to anonymous when
 * the Clerk SDK throws its missing-key error, so protected routes 401 via
 * `requireAuth()` while public routes keep serving (never a framework 500).
 */
export function hasClerkSecret(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.CLERK_SECRET_KEY ?? "").trim() !== "";
}

/**
 * Pure session-to-context projection (no SDK import): maps a Clerk session
 * shape to an AuthContext, normalizing the fast `tubelens.tier` claim via
 * `getEffectiveTier` (missing/invalid → `free`, never self-escalating) and
 * the `metadata.role` claim via `getEffectiveRole` (missing/invalid →
 * `user`, least privilege). Signed-out/malformed sessions resolve
 * anonymous. Exported pure so unit tests cover the claim mapping without
 * initializing the Clerk SDK; the live provider below only handles
 * import/config plumbing.
 */
export function contextFromClerkSession(
  session:
    | {
        userId?: unknown;
        sessionClaims?: unknown;
      }
    | null
    | undefined,
): AuthContext {
  const userId = session?.userId;
  if (typeof userId === "string" && userId !== "") {
    return {
      type: "user",
      authenticated: true,
      userId,
      tier: getEffectiveTier(session?.sessionClaims),
      role: getEffectiveRole(session?.sessionClaims),
    };
  }
  return { ...anonymousAuthContext };
}

/**
 * Resolve the caller principal via the Clerk session, with a Phase 05
 * machine-auth fallback:
 *
 * 1. Session-first: the interactive browser session (unchanged Phase 02/03
 *    behavior, including its tier/role claim projection).
 * 2. Bearer-fallback: when the session yields anonymous AND the request
 *    carries `Authorization: Bearer ak_*`, verify the secret as a Clerk API
 *    key and resolve `{ type: "api_key", keyId, userId: subject, tier }`.
 *    The tier comes from the subject's authoritative `publicMetadata` via
 *    the same least-privilege `normalizeTier` fallback `getEffectiveTier`
 *    uses (missing/invalid → `free`, never throws) — there is no session
 *    claim for machine callers, so the write-path rule applies here too:
 *    re-fetch, never trust client input.
 *
 * Fail-closed throughout: any verification failure (missing / malformed /
 * revoked / expired secret, Clerk outage, timeout) resolves anonymous, so
 * protected routes deny via `requireAuth()` (401) while public routes keep
 * serving. The plaintext secret is never logged, stored, or audited — it is
 * held only in the local `secret` binding for the duration of `verify`.
 *
 * - Fail-safe first: when TUBELENS_AUTH_ENFORCEMENT=required without
 *   CLERK_SECRET_KEY, `getConfig` throws a typed ConfigError — protection
 *   is never silently disabled.
 * - Keyless-safe: without a secret (local unit tests, unconfigured envs)
 *   there is no session to resolve — session resolution is skipped, and the
 *   Bearer path runs against the configured client (a mock in tests; the
 *   live client fails closed without a secret). Public routes keep serving.
 * - Degrade closed: any Clerk failure resolves anonymous. Protection still
 *   holds because protected routes deny anonymous via `requireAuth()` (401)
 *   while public routes serve — failures deny, never bypass.
 */
export const clerkAuthProvider: AuthProvider = {
  async resolve(req: Request): Promise<AuthContext> {
    getConfig(process.env);
    const sessionCtx = await resolveSessionContext();
    if (sessionCtx.authenticated) {
      return sessionCtx;
    }
    return resolveApiKeyContext(extractBearerSecret(req), getApiKeysClient());
  },
};

/**
 * Session leg: anonymous when unconfigured (no secret) or on any Clerk
 * failure. Factored out so the Bearer fallback below runs even in keyless
 * unit tests (where a mocked key client is injected).
 */
async function resolveSessionContext(): Promise<AuthContext> {
  if (!hasClerkSecret()) {
    return { ...anonymousAuthContext };
  }
  try {
    // Lazy import: keyless envs and unit tests never initialize the Clerk
    // SDK. `auth()` is async in the v7 SDK — `await` covers both shapes.
    // Claim mapping itself lives in the pure `contextFromClerkSession`
    // above (unit-tested without the SDK); this block is import/config
    // plumbing only.
    const { auth } = await import("@clerk/nextjs/server");
    return contextFromClerkSession(await auth());
  } catch {
    return { ...anonymousAuthContext };
  }
}

/**
 * Extract the Bearer secret from `Authorization` (case-insensitive scheme).
 * Only `ak_*` machine secrets are attempted — anything else (absent header,
 * wrong scheme, non-key token) yields undefined so non-key bearers never
 * reach the verify endpoint.
 */
export function extractBearerSecret(req: {
  headers: { get(name: string): string | null };
}): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) {
    return undefined;
  }
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const secret = match?.[1]?.trim();
  if (!secret || !secret.startsWith("ak_")) {
    return undefined;
  }
  return secret;
}

/**
 * Bearer leg: verify a machine secret and project the key principal.
 * Exported so tests cover the verify→context mapping with a mocked client
 * without HTTP. `secret === undefined` (no/foreign bearer) resolves
 * anonymous without a Backend call. Never throws — every failure path
 * resolves anonymous (fail closed via `requireAuth()` downstream).
 */
export async function resolveApiKeyContext(
  secret: string | undefined,
  client: ApiKeysClient,
): Promise<AuthContext> {
  if (!secret) {
    return { ...anonymousAuthContext };
  }
  let verified: Awaited<ReturnType<ApiKeysClient["verifyKey"]>>;
  try {
    verified = await client.verifyKey(secret, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Missing/malformed/revoked/expired secret, timeout, or outage: deny
    // (protected routes 401), never bypass.
    return { ...anonymousAuthContext };
  }
  // Fail-closed guard: never trust a verified payload that already carries
  // revoked/expired — deny even if the authority resolved instead of threw.
  if (verified.revoked || verified.expired) {
    return { ...anonymousAuthContext };
  }
  let tier: Tier = "free";
  try {
    const subject = await client.getUser(verified.subject, {
      signal: AbortSignal.timeout(8000),
    });
    tier = normalizeTier(subject.publicMetadata?.tier);
  } catch (err) {
    // A 404 names a deleted subject — the key no longer binds a live user,
    // so deny rather than serve a dangling principal. Only transient /
    // non-404 failures fall back to least-privilege `free` (the key itself
    // verified, so an unreadable tier must not lock it out — and never an
    // escalation).
    if (clerkErrorStatus(err) === 404) {
      return { ...anonymousAuthContext };
    }
    tier = "free";
  }
  touchKeyLastUsed(verified.id);
  return {
    type: "api_key",
    authenticated: true,
    userId: verified.subject,
    tier,
    keyId: verified.id,
    // Phase 07: project the key's scopes so `requireScope()` can gate
    // future write scopes. Copied (never aliased) from the verified record;
    // `?? []` guards an authority that omits scopes so a missing field can
    // never throw into a bare 500.
    scopes: [...(verified.scopes ?? [])],
  };
}
