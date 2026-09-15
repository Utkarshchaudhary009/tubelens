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

import type { AuthContext, AuthProvider } from "./auth";
import { anonymousAuthContext } from "./auth";
import { getConfig } from "./config";
import { getEffectiveTier } from "./product";

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
 * `getEffectiveTier` (missing/invalid → `free`, never self-escalating).
 * Signed-out/malformed sessions resolve anonymous. Exported pure so unit
 * tests cover the claim mapping without initializing the Clerk SDK; the
 * live provider below only handles import/config plumbing.
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
    };
  }
  return { ...anonymousAuthContext };
}

/**
 * Resolve the caller principal via the Clerk session.
 *
 * Tier projection (Phase 03): `sessionClaims.tubelens.tier` carries the
 * fast claim minted by the Dashboard session-token template
 * (`{"metadata":"{{user.public_metadata}}","tubelens":{"tier":"{{user.public_metadata.tier}}"}}`,
 * custom claims <1.2KB). It is normalized via `getEffectiveTier` onto the
 * returned context so the pipeline's `ctx.tier` reflects the claim without
 * a Backend API call. Signed-out/malformed → anonymous (no tier);
 * authenticated + missing/invalid → `free`;
 * the projection lags metadata changes by ~60s, so security-sensitive
 * write paths must re-fetch authoritative Clerk metadata (Phase 04).
 *
 * - Fail-safe first: when TUBELENS_AUTH_ENFORCEMENT=required without
 *   CLERK_SECRET_KEY, `getConfig` throws a typed ConfigError — protection
 *   is never silently disabled.
 * - Keyless-safe: without a secret (local unit tests, unconfigured envs)
 *   there is no session to resolve — return anonymous, never throw, so
 *   public routes keep serving.
 * - Degrade closed: any Clerk failure (no proxy headers, outage,
 *   misconfiguration) resolves anonymous. Protection still holds because
 *   protected routes deny anonymous via `requireAuth()` (401) while public
 *   routes serve — failures deny, never bypass.
 */
export const clerkAuthProvider: AuthProvider = {
  async resolve(_req: Request): Promise<AuthContext> {
    getConfig(process.env);
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
  },
};
