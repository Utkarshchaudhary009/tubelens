import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleHealth } from "../../app/api/v1/health/route";
import { handleMe, GET as meGET } from "../../app/api/v1/me/route";
import {
  type AuthProvider,
  anonymousAuthProvider,
  getAuthProvider,
  requireAuth,
  resetAuthProvider,
  unauthenticatedResponse,
} from "../auth";
import {
  AUTHENTICATED_ROUTES,
  clerkAuthProvider,
  hasClerkSecret,
  routeAuthKind,
} from "../clerk-auth";
import { ConfigError } from "../config";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";

function req(url: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, { headers });
}

// Env + provider hygiene: Phase 02 tests mutate process.env for fail-safe
// coverage — always restore so later files see a clean keyless env.
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

describe("requireAuth gate (Phase 02)", () => {
  test("authenticated principal passes with undefined", () => {
    expect(
      requireAuth({
        auth: { type: "user", authenticated: true, userId: "user_1" },
        requestId: "r-1",
      }),
    ).toBeUndefined();
  });

  test("anonymous caller gets typed 401 JSON, never a redirect/404", () => {
    const res = unauthenticatedResponse("anon-1");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-Request-Id")).toBe("anon-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("requireAuth denial carries code + one-sentence hint", async () => {
    const denied = requireAuth({
      auth: { type: "anonymous", authenticated: false },
      requestId: "anon-2",
    });
    expect(denied).toBeDefined();
    expect(denied?.status).toBe(401);
    const body = await denied?.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.status).toBe(401);
    expect(typeof body.error.hint).toBe("string");
    expect(body.error.hint.length).toBeGreaterThan(0);
    expect(body.error.hint).not.toContain("\n");
    expect("stack" in body.error).toBe(false);
    expect(body.meta.requestId).toBe("anon-2");
  });
});

describe("GET /api/v1/me (protected proof endpoint)", () => {
  test("unauthenticated caller gets 401 unauthenticated + hint + request id", async () => {
    keylessEnv();
    const res = await meGET(req("http://x/api/v1/me", "me-401"));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBe("me-401");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(typeof body.error.hint).toBe("string");
    expect(body.meta.requestId).toBe("me-401");
  });

  test("fake-authenticated user gets 200 envelope with userId", async () => {
    const res = handleMe(
      "me-200",
      { type: "user", authenticated: true, userId: "user_abc" },
      "free",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("me-200");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({ userId: "user_abc", tier: "free" });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("me-200");
    expect(body.meta.region).toBe("US");
    expect(body.meta.lang).toBe("en");
    expect(body.warnings).toEqual([]);
  });

  test("authenticated non-user principal (future api-key) still gets 401", async () => {
    const res = handleMe(
      "me-key",
      { type: "api_key", authenticated: true, keyId: "key_1" },
      "free",
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  test("non-user principal carrying a subject userId still gets 401", async () => {
    const res = handleMe(
      "me-key-subject",
      {
        type: "api_key",
        authenticated: true,
        keyId: "key_1",
        userId: "user_abc",
      },
      "free",
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  test("route wiring: pipeline with injected user provider yields 200", async () => {
    // Mirrors GET's wiring (`withRequestContext(..., { auth }, "me")`) with
    // a stub user provider: a dropped provider or wrong-ctx miswire in GET
    // fails here instead of hiding behind the pure-handleMe tests above.
    keylessEnv();
    const stubUserProvider: AuthProvider = {
      resolve: () => ({
        type: "user",
        authenticated: true,
        userId: "user_wire",
      }),
    };
    const run = withRequestContext(
      async (_r, ctx) => handleMe(ctx.requestId, ctx.auth, ctx.tier),
      { auth: stubUserProvider },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "me-wire"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("me-wire");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({ userId: "user_wire", tier: "free" });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("me-wire");
  });

  test("public pipeline still serves anonymously; global default untouched", async () => {
    let seen: unknown;
    const run = withRequestContext(
      async (_r, ctx) => {
        seen = ctx.auth;
        return handleHealth(ctx.requestId, {
          checkSession: async () => {},
        });
      },
      {},
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "pub-1"));
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ type: "anonymous", authenticated: false });
    expect((await res.json()).data).toMatchObject({ ok: true });
    // Phase 02 registers no global side effects: importing the Clerk seam
    // must not flip the default provider Part A routes resolve through.
    expect(getAuthProvider()).toBe(anonymousAuthProvider);
  });
});

describe("route classification (Phase 02 decision)", () => {
  test("/me is authenticated; Part A reads stay public", () => {
    expect(AUTHENTICATED_ROUTES).toContain("/api/v1/me");
    expect(routeAuthKind("/api/v1/me")).toBe("authenticated");
    for (const pub of [
      "/api/v1/health",
      "/api/v1/search",
      "/api/v1/videos/abc",
      "/api/v1/openapi.json",
    ]) {
      expect(routeAuthKind(pub)).toBe("public");
    }
  });

  test("success envelope helper still serves a public probe", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {},
      "health",
    );
    expect((await run(req("http://x/api/v1/health"))).status).toBe(200);
  });
});

describe("secret safety + fail-safe (Phase 02)", () => {
  test("CLERK_SECRET_KEY value never appears in responses", async () => {
    const canary = "sk_test_canary_phase02_no_leak";
    keylessEnv();
    process.env.CLERK_SECRET_KEY = canary;
    try {
      const denied = await meGET(req("http://x/api/v1/me", "leak-1"));
      const allowed = handleMe(
        "leak-2",
        { type: "user", authenticated: true, userId: "user_abc" },
        "free",
      );
      for (const res of [denied, allowed]) {
        const raw = JSON.stringify(await res.clone().json());
        expect(raw).not.toContain(canary);
        for (const [_k, v] of res.headers.entries()) {
          expect(v).not.toContain(canary);
        }
      }
      // Belt-and-suspenders: the denial path above must actually have run
      // through the Clerk provider (anonymous without middleware headers).
      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.CLERK_SECRET_KEY;
    }
  });

  test("required enforcement without secret fails safe at the pipeline", async () => {
    let ran = false;
    const run = withRequestContext(
      async (_r, ctx) => {
        ran = true;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      { env: { TUBELENS_AUTH_ENFORCEMENT: "required" } },
      "me",
    );
    const res = await run(req("http://x/api/v1/me", "safe-1"));
    expect(ran).toBe(false);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("missing_security_config");
    expect(typeof body.error.hint).toBe("string");
    expect(body.meta.requestId).toBe("safe-1");
  });

  test("provider fails safe (typed throw) when required + secret missing", async () => {
    delete process.env.CLERK_SECRET_KEY;
    process.env.TUBELENS_AUTH_ENFORCEMENT = "required";
    try {
      await clerkAuthProvider.resolve(new Request("http://x/api/v1/me"));
      expect.unreachable("must throw, never silently serve unprotected");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("missing_security_config");
    }
  });

  test("keyless provider resolves anonymous without throwing", async () => {
    keylessEnv();
    const ctx = await clerkAuthProvider.resolve(
      new Request("http://x/api/v1/me"),
    );
    expect(ctx).toMatchObject({ type: "anonymous", authenticated: false });
    expect(ctx.userId).toBeUndefined();
  });

  test("attach gate keys on the secret alone, not the publishable key", () => {
    // Secret-without-publishable is a half-configured deploy, not a keyless
    // one: proxy and provider must both attempt attach (and degrade to
    // anonymous downstream) rather than disagree about whether Clerk runs.
    expect(hasClerkSecret({ CLERK_SECRET_KEY: "sk_test_x" })).toBe(true);
    expect(hasClerkSecret({})).toBe(false);
    expect(hasClerkSecret({ CLERK_SECRET_KEY: "   " })).toBe(false);
  });

  test("proxy passes through keyless and degrades half-configured, never throws", async () => {
    const { default: proxy } = await import("../../proxy");
    const event = { waitUntil: () => {} } as never;
    keylessEnv();
    const keyless = await proxy(new NextRequest("http://x/api/v1/me"), event);
    expect(keyless?.headers.get("x-middleware-next")).toBe("1");
    // Secret without publishable key: Clerk throws its missing-key error at
    // request time; the proxy degrades to pass-through (anonymous) so the
    // route layer answers typed 401/200 instead of a framework 500.
    process.env.CLERK_SECRET_KEY = "sk_test_half_configured";
    try {
      const degraded = await proxy(
        new NextRequest("http://x/api/v1/me"),
        event,
      );
      expect(degraded?.headers.get("x-middleware-next")).toBe("1");
    } finally {
      delete process.env.CLERK_SECRET_KEY;
    }
  });
});
