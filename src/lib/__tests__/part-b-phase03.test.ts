import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleMe, GET as meGET } from "../../app/api/v1/me/route";
import type { AuthContext, AuthProvider } from "../auth";
import { resetAuthProvider } from "../auth";
import { clerkAuthProvider, contextFromClerkSession } from "../clerk-auth";
import { withRequestContext } from "../pipeline";
import { getEffectiveTier } from "../product";

function req(url: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, { headers });
}

// Env hygiene: this file mutates process.env for attach-gate coverage —
// always restore so later files see a clean keyless env.
const savedEnforcement = process.env.TUBELENS_AUTH_ENFORCEMENT;
const savedSecret = process.env.CLERK_SECRET_KEY;
const savedPublishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

afterEach(() => {
  resetAuthProvider();
  if (savedEnforcement === undefined) {
    delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  } else {
    process.env.TUBELENS_AUTH_ENFORCEMENT = savedEnforcement;
  }
  if (savedSecret === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = savedSecret;
  }
  if (savedPublishable === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = savedPublishable;
  }
});

function keylessEnv(): void {
  delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

/**
 * Stub auth provider standing in for a signed-in Clerk session: mirrors
 * what `clerkAuthProvider` returns for the given session shape (via the
 * shared pure `contextFromClerkSession`), following the Phase 02 stub-
 * provider pattern — no live Clerk keys, no SDK import.
 */
function stubSessionProvider(session: {
  userId?: unknown;
  sessionClaims?: unknown;
}): AuthProvider {
  const ctx: AuthContext = contextFromClerkSession(session);
  return { resolve: () => ({ ...ctx }) };
}

describe("getEffectiveTier (Phase 03 claim projection)", () => {
  test("defaults to free on undefined/empty claims", () => {
    for (const claims of [
      undefined,
      null,
      {},
      { tubelens: null },
      { tubelens: {} },
      { tubelens: { tier: undefined } },
      "plus",
      42,
      [],
    ]) {
      expect(getEffectiveTier(claims)).toBe("free");
    }
  });

  test("passes canonical tiers through as-is", () => {
    for (const tier of ["free", "plus", "pro", "enterprise"] as const) {
      expect(getEffectiveTier({ tubelens: { tier } })).toBe(tier);
    }
  });

  test("falls back to free on invalid/team/non-string/oversized claims", () => {
    for (const tier of [
      "team",
      "TEAM",
      "Plus",
      "admin",
      "",
      " ",
      "free ",
      42,
      true,
      null,
      ["plus"],
      { tier: "plus" },
      "x".repeat(2000),
    ]) {
      expect(getEffectiveTier({ tubelens: { tier } })).toBe("free");
    }
  });

  test("never throws on malformed input", () => {
    const throwing = {
      get tubelens(): unknown {
        throw new Error("poisoned getter");
      },
    };
    expect(getEffectiveTier(throwing)).toBe("free");
  });

  test("stale claim returns the claim value, not authoritative state", () => {
    // The session token lags Clerk metadata by ~60s: if the authoritative
    // tier was just raised to pro but the token still projects free, the
    // fast path honestly reports free. Write paths must re-fetch
    // authoritative state via getUser (Phase 04) instead of trusting this.
    expect(getEffectiveTier({ tubelens: { tier: "free" } })).toBe("free");
    expect(getEffectiveTier({ tubelens: { tier: "plus" } })).toBe("plus");
  });
});

describe("contextFromClerkSession (Phase 03 provider mapping)", () => {
  test("plus claim surfaces tier plus on the auth context", () => {
    expect(
      contextFromClerkSession({
        userId: "user_plus",
        sessionClaims: { tubelens: { tier: "plus" } },
      }),
    ).toMatchObject({
      type: "user",
      authenticated: true,
      userId: "user_plus",
      tier: "plus",
    });
  });

  test("invalid claim keeps the user authenticated but tier free", () => {
    expect(
      contextFromClerkSession({
        userId: "user_bad",
        sessionClaims: { tubelens: { tier: "team" } },
      }),
    ).toMatchObject({
      type: "user",
      authenticated: true,
      userId: "user_bad",
      tier: "free",
    });
  });

  test("missing claim resolves an authenticated user at free", () => {
    expect(
      contextFromClerkSession({ userId: "user_noclaim", sessionClaims: {} }),
    ).toMatchObject({ type: "user", authenticated: true, tier: "free" });
    expect(contextFromClerkSession({ userId: "user_noclaim" })).toMatchObject({
      type: "user",
      authenticated: true,
      tier: "free",
    });
  });

  test("signed-out/malformed sessions resolve anonymous with no tier", () => {
    for (const session of [
      null,
      undefined,
      {},
      { userId: null, sessionClaims: {} },
      { userId: "", sessionClaims: { tubelens: { tier: "plus" } } },
      { userId: 42, sessionClaims: { tubelens: { tier: "plus" } } },
    ]) {
      const ctx = contextFromClerkSession(session);
      expect(ctx).toMatchObject({ type: "anonymous", authenticated: false });
      expect(ctx.tier).toBeUndefined();
    }
  });

  test("keyless live provider resolves anonymous without throwing", async () => {
    keylessEnv();
    const ctx = await clerkAuthProvider.resolve(
      new Request("http://x/api/v1/me"),
    );
    expect(ctx).toMatchObject({ type: "anonymous", authenticated: false });
    expect(ctx.tier).toBeUndefined();
  });
});

describe("pipeline + /me tier surfacing (Phase 03)", () => {
  test("plus claim flows through the pipeline into ctx.tier + /me", async () => {
    keylessEnv();
    let seenTier: unknown;
    const run = withRequestContext(
      async (_r, ctx) => {
        seenTier = ctx.tier;
        return handleMe(ctx.requestId, ctx.auth, ctx.tier);
      },
      {
        auth: stubSessionProvider({
          userId: "user_plus",
          sessionClaims: { tubelens: { tier: "plus" } },
        }),
      },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "tier-plus-1"));
    expect(seenTier).toBe("plus");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ userId: "user_plus", tier: "plus" });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("tier-plus-1");
  });

  test("pro claim yields 200 with tier pro and private no-store caching", async () => {
    keylessEnv();
    const run = withRequestContext(
      async (_r, ctx) => handleMe(ctx.requestId, ctx.auth, ctx.tier),
      {
        auth: stubSessionProvider({
          userId: "user_pro",
          sessionClaims: { tubelens: { tier: "pro" } },
        }),
      },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "me-pro-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("me-pro-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await res.json()).data).toEqual({
      userId: "user_pro",
      tier: "pro",
    });
  });

  test("GET /api/v1/me still 401s anonymously (keyless contract intact)", async () => {
    keylessEnv();
    const res = await meGET(req("http://x/api/v1/me", "me-anon-1"));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBe("me-anon-1");
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.meta.requestId).toBe("me-anon-1");
  });

  test("anonymous pipeline tier stays free (byte-identical contract)", async () => {
    keylessEnv();
    let seenTier: unknown;
    let seenEntitlements: unknown;
    const run = withRequestContext(
      async (_r, ctx) => {
        seenTier = ctx.tier;
        seenEntitlements = ctx.entitlements;
        return handleMe(ctx.requestId, ctx.auth, ctx.tier);
      },
      { auth: clerkAuthProvider },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "tier-anon-1"));
    expect(seenTier).toBe("free");
    expect(seenEntitlements).toMatchObject({ tier: "free" });
    expect(res.status).toBe(401);
  });

  test("non-free claim label grants no extra allowance (no self-escalation)", async () => {
    keylessEnv();
    let seen: { tier?: unknown; monthlyCredits?: unknown } = {};
    const run = withRequestContext(
      async (_r, ctx) => {
        seen = { ...ctx.entitlements };
        return handleMe(ctx.requestId, ctx.auth, ctx.tier);
      },
      {
        auth: stubSessionProvider({
          userId: "user_ent",
          sessionClaims: { tubelens: { tier: "enterprise" } },
        }),
      },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "tier-ent-1"));
    expect(res.status).toBe(200);
    // Reserved tiers project the free snapshot under their own label.
    expect(seen.tier).toBe("enterprise");
    expect(seen.monthlyCredits).toBe(10_000);
  });
});
