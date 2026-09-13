import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { handleHealth } from "../../app/api/v1/health/route";
import {
  anonymousAuthContext,
  anonymousAuthProvider,
  getAuthProvider,
  resetAuthProvider,
  setAuthProvider,
} from "../auth";
import { ConfigError, getConfig, requireSecuritySecret } from "../config";
import { successResponse } from "../envelope";
import {
  getObservabilityProvider,
  noopObservabilityProvider,
  resetObservabilityProvider,
  setObservabilityProvider,
} from "../observability";
import { createRequestContext, withRequestContext } from "../pipeline";
import {
  getProductPolicyProvider,
  normalizeTier,
  resetProductPolicyProvider,
} from "../product";
import {
  allowAllRateLimitProvider,
  getRateLimitProvider,
  resetRateLimitProvider,
  setRateLimitProvider,
} from "../rate-limit";
import {
  getUsageRecorder,
  noopUsageRecorder,
  resetUsageRecorder,
} from "../usage";

function req(url: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, { headers });
}

// Global provider swaps must never leak across tests: a failed assertion
// mid-test must not contaminate later ones.
afterEach(() => {
  resetAuthProvider();
  resetRateLimitProvider();
  resetObservabilityProvider();
  resetUsageRecorder();
  resetProductPolicyProvider();
});

describe("request context (Phase 01)", () => {
  test("echoes caller X-Request-Id into typed context", async () => {
    const ctx = await createRequestContext(
      req("http://x/api/v1/health", "caller-1"),
    );
    expect(ctx.requestId).toBe("caller-1");
    expect(ctx.traceId).toBe("caller-1");
    expect(ctx.auth).toMatchObject({ type: "anonymous", authenticated: false });
    expect(ctx.tier).toBe("free");
    expect(ctx.entitlements.tier).toBe("free");
    expect(typeof ctx.rateLimitIdentity).toBe("string");
    expect(typeof ctx.startedAt).toBe("number");
  });

  test("mints a requestId when the caller sends none", async () => {
    const ctx = await createRequestContext(req("http://x/api/v1/health"));
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ctx.traceId).toBe(ctx.requestId);
  });

  test("pipelined response preserves echoed id in header + meta", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {},
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "echo-9"));
    expect(res.headers.get("X-Request-Id")).toBe("echo-9");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
    expect((await res.json()).meta.requestId).toBe("echo-9");
  });
});

describe("config validation + failure policy (Phase 01)", () => {
  test("missing optional observability vars degrade gracefully", () => {
    const cfg = getConfig({});
    expect(cfg.observability.enabled).toBe(false);
    expect(cfg.authEnforcement).toBe("off");
  });

  test("API still serves with observability disabled", async () => {
    const cfg = getConfig({});
    expect(cfg.observability.enabled).toBe(false);
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { observability: noopObservabilityProvider },
      "health",
    );
    const res = await run(req("http://x/api/v1/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ok: true });
  });

  test("required security secret missing fails safely (typed throw)", () => {
    expect(() => getConfig({ TUBELENS_AUTH_ENFORCEMENT: "required" })).toThrow(
      ConfigError,
    );
    expect(() =>
      requireSecuritySecret(
        {},
        "CLERK_SECRET_KEY",
        "Set it in secret storage.",
      ),
    ).toThrow(ConfigError);
    try {
      requireSecuritySecret({}, "CLERK_SECRET_KEY", "Set it.");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("missing_security_config");
    }
  });

  test("required secret present passes validation", () => {
    const cfg = getConfig({
      TUBELENS_AUTH_ENFORCEMENT: "required",
      CLERK_SECRET_KEY: "sk_test_123",
    });
    expect(cfg.authEnforcement).toBe("required");
    expect(
      requireSecuritySecret(
        { CLERK_SECRET_KEY: "sk_test_123" },
        "CLERK_SECRET_KEY",
        "Set it.",
      ),
    ).toBe("sk_test_123");
  });
});

describe("provider boundaries (Phase 01)", () => {
  test("defaults are registered, no-op, and never throw", async () => {
    expect(getAuthProvider()).toBe(anonymousAuthProvider);
    expect(await getAuthProvider().resolve(req("http://x/"))).toMatchObject({
      type: "anonymous",
      authenticated: false,
    });
    expect(getRateLimitProvider()).toBe(allowAllRateLimitProvider);
    const decision = await getRateLimitProvider().check({ identity: "anon:x" });
    expect(decision.allowed).toBe(true);
    // Usage + observability no-ops resolve without throwing.
    await getUsageRecorder().record({
      requestId: "r",
      route: "health",
      operation: "health",
      cost: 1,
      policyVersion: "2026-09-13.free.v1",
      outcome: "accepted",
    });
    expect(getUsageRecorder()).toBe(noopUsageRecorder);
    const obs = getObservabilityProvider();
    const span = obs.startSpan("test");
    span.recordError(new Error("x"));
    span.end();
    obs.log("info", "msg");
    obs.increment("metric");
    obs.captureError(new Error("x"));
    expect(getProductPolicyProvider().resolveTier({ type: "anonymous" })).toBe(
      "free",
    );
  });

  test("custom fake providers can be injected per request", async () => {
    const seen: string[] = [];
    const run = withRequestContext(
      async (_r, ctx) => {
        seen.push(ctx.auth.userId ?? "none", ctx.tier);
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      {
        auth: {
          resolve: () => ({
            type: "user",
            authenticated: true,
            userId: "user_1",
          }),
        },
        usage: {
          record: (e) => {
            seen.push(`usage:${e.outcome}`);
          },
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health"));
    expect(res.status).toBe(200);
    // Accounting is dispatched in a later macrotask; yield to the timers
    // phase before asserting the recorder ran.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["user_1", "free", "usage:accepted"]);
  });

  test("global providers are swappable and resettable", async () => {
    setAuthProvider({
      resolve: () => ({ type: "api_key", authenticated: true, keyId: "key_1" }),
    });
    const ctx = await createRequestContext(req("http://x/api/v1/health"));
    expect(ctx.auth.keyId).toBe("key_1");
    expect(ctx.rateLimitIdentity).toBe("key:key_1");
    resetAuthProvider();
    expect(getAuthProvider()).toBe(anonymousAuthProvider);

    setRateLimitProvider({
      check: () => ({
        allowed: false,
        limit: 10,
        remaining: 0,
        reset: 123,
        retryAfter: 5,
      }),
    });
    const denied = withRequestContext(
      async (_r, ctx2) =>
        successResponse({ ok: true }, { requestId: ctx2.requestId }),
      {},
      "health",
    );
    const res = await denied(req("http://x/api/v1/health", "deny-1"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect((await res.json()).error.code).toBe("rate_limited");
    resetRateLimitProvider();

    let logged = 0;
    setObservabilityProvider({
      ...noopObservabilityProvider,
      log: () => {
        logged += 1;
      },
    });
    const ok = withRequestContext(
      async (_r, ctx3) =>
        successResponse({ ok: true }, { requestId: ctx3.requestId }),
      {},
      "health",
    );
    expect((await ok(req("http://x/api/v1/health"))).status).toBe(200);
    expect(logged).toBe(1);
    resetObservabilityProvider();
    resetUsageRecorder();
    resetProductPolicyProvider();
  });

  test("a throwing limiter fails safely with 503, never silently unprotected", async () => {
    const run = withRequestContext(
      async () => NextResponse.json({ unreachable: true }),
      {
        rateLimit: {
          check: () => {
            throw new Error("redis down");
          },
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "lim-1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(body.meta.requestId).toBe("lim-1");
  });
});

describe("review hardening (Phase 01)", () => {
  test("pipelined health is byte/shape compatible with direct handleHealth", async () => {
    const deps = { checkSession: async () => {} };
    const direct = await handleHealth("byte-1", deps);
    const run = withRequestContext(
      async (_r, ctx) => handleHealth(ctx.requestId, deps),
      {},
      "health",
    );
    const pipelined = await run(req("http://x/api/v1/health", "byte-1"));
    expect(pipelined.status).toBe(direct.status);
    expect(await pipelined.json()).toEqual(await direct.json());
    for (const name of [
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "Cache-Control",
      "Content-Type",
    ]) {
      expect(pipelined.headers.get(name)).toBe(direct.headers.get(name));
    }
    expect(pipelined.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
    // Success headers come from the limiter decision; the Phase 01
    // allow-all default matches the Part A stubs.
    expect(pipelined.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(pipelined.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  test("throwing auth/product providers fail safe with typed 503 JSON", async () => {
    const unreachable = async () => NextResponse.json({ unreachable: true });
    const failing = [
      {
        auth: {
          resolve: () => {
            throw new Error("clerk down");
          },
        },
      },
      {
        product: {
          resolveTier: () => {
            throw new Error("policy store down");
          },
          entitlementsFor: () => {
            throw new Error("unreachable");
          },
        },
      },
    ];
    for (const providers of failing) {
      const run = withRequestContext(unreachable, providers, "health");
      const res = await run(req("http://x/api/v1/health", "auth-1"));
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(res.headers.get("X-Request-Id")).toBe("auth-1");
      const body = await res.json();
      expect(body.error.code).toBe("dependency_unavailable");
      expect(typeof body.error.hint).toBe("string");
      expect(JSON.stringify(body)).not.toContain("clerk down");
      expect(JSON.stringify(body)).not.toContain("policy store down");
      expect(body.meta.requestId).toBe("auth-1");
    }
  });

  test("throwing handler returns typed 500 JSON, never a stack leak", async () => {
    const run = withRequestContext(
      async () => {
        throw new Error("secret boom");
      },
      {},
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "h-500"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-Request-Id")).toBe("h-500");
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(typeof body.error.hint).toBe("string");
    expect("stack" in body.error).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret boom");
    expect(body.meta.requestId).toBe("h-500");
  });

  test("oversized/invalid x-request-id values are replaced with a minted id", async () => {
    for (const bad of ["x".repeat(200), "has spaces!", "a/b?c", ""]) {
      const ctx = await createRequestContext(
        req("http://x/api/v1/health", bad),
      );
      expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(ctx.requestId).not.toBe(bad);
    }
    // Boundary: a 128-char token stays echoed.
    const edge = "y".repeat(128);
    const kept = await createRequestContext(
      req("http://x/api/v1/health", edge),
    );
    expect(kept.requestId).toBe(edge);
  });

  test("429 responses carry the limiter decision's header values", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        rateLimit: {
          check: () => ({
            allowed: false,
            limit: 10,
            remaining: 0,
            reset: 123,
            retryAfter: 5,
          }),
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "d-429"));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("123");
    expect(res.headers.get("X-Request-Id")).toBe("d-429");
  });

  test("missing security config maps to typed 503 without running the handler", async () => {
    let ran = false;
    const run = withRequestContext(
      async (_r, ctx) => {
        ran = true;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      { env: { TUBELENS_AUTH_ENFORCEMENT: "required" } },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "cfg-1"));
    expect(ran).toBe(false);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("missing_security_config");
    expect(typeof body.error.hint).toBe("string");
    expect(body.meta.requestId).toBe("cfg-1");
    expect(res.headers.get("X-Request-Id")).toBe("cfg-1");
  });

  test("pipeline serves when the required secret is present", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        env: {
          TUBELENS_AUTH_ENFORCEMENT: "required",
          CLERK_SECRET_KEY: "sk_test_123",
        },
      },
      "health",
    );
    expect((await run(req("http://x/api/v1/health"))).status).toBe(200);
  });

  test("a throwing observability provider never breaks the response", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        observability: {
          startSpan: () => {
            throw new Error("otel down");
          },
          log: () => {
            throw new Error("log down");
          },
          increment: () => {
            throw new Error("metric down");
          },
          captureError: () => {
            throw new Error("report down");
          },
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "obs-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).meta.requestId).toBe("obs-1");
  });
});

describe("cubic review findings", () => {
  test("anonymous defaults are frozen against mutation", () => {
    expect(Object.isFrozen(anonymousAuthContext)).toBe(true);
    expect(Object.isFrozen(anonymousAuthProvider)).toBe(true);
    expect(() => {
      (anonymousAuthContext as { type: string }).type = "user";
    }).toThrow();
    expect(anonymousAuthContext.type).toBe("anonymous");
  });

  test("normalizeTier only honors active tiers; reserved fall back to free", () => {
    expect(normalizeTier("free")).toBe("free");
    for (const reserved of [
      "pro",
      "team",
      "enterprise",
      "admin",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(normalizeTier(reserved)).toBe("free");
    }
  });

  test("unknown TUBELENS_AUTH_ENFORCEMENT fails closed, not fail-open", () => {
    expect(() => getConfig({ TUBELENS_AUTH_ENFORCEMENT: "yes" })).toThrow(
      ConfigError,
    );
    expect(getConfig({}).authEnforcement).toBe("off");
    expect(
      getConfig({ TUBELENS_AUTH_ENFORCEMENT: "off" }).authEnforcement,
    ).toBe("off");
  });

  test("whitespace-only CLERK_SECRET_KEY is rejected like a missing one", () => {
    expect(() =>
      getConfig({
        TUBELENS_AUTH_ENFORCEMENT: "required",
        CLERK_SECRET_KEY: "   ",
      }),
    ).toThrow(ConfigError);
  });

  test("anonymous rate-limit identity ignores X-Forwarded-For", async () => {
    const forwarded = req("http://x/api/v1/health", "anon-1");
    forwarded.headers.set("x-forwarded-for", "1.2.3.4, 5.6.7.8");
    const ctx = await createRequestContext(forwarded);
    expect(ctx.rateLimitIdentity).toBe("anonymous");
  });

  test("bypassRateLimit serves liveness despite a deny-all limiter", async () => {
    let ran = false;
    const run = withRequestContext(
      async (_r, ctx) => {
        ran = true;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      {
        rateLimit: {
          check: () => ({
            allowed: false,
            limit: 1,
            remaining: 0,
            reset: 1,
            retryAfter: 1,
          }),
        },
      },
      "health",
      { bypassRateLimit: true },
    );
    const res = await run(req("http://x/api/v1/health", "live-1"));
    expect(ran).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("live-1");
  });

  test("success responses carry the limiter decision's header values", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        rateLimit: {
          check: () => ({ allowed: true, limit: 7, remaining: 3, reset }),
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "dec-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("7");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("3");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String(reset));
    expect((await res.json()).meta.requestId).toBe("dec-1");
  });

  test("slow or failing accounting never delays or breaks the response", async () => {
    const recorders = [
      { record: () => new Promise<void>(() => {}) },
      {
        record: () => Promise.reject(new Error("ledger down")),
      },
    ];
    for (const usage of recorders) {
      const run = withRequestContext(
        async (_r, ctx) =>
          successResponse({ ok: true }, { requestId: ctx.requestId }),
        { usage },
        "health",
      );
      const started = Date.now();
      const res = await run(req("http://x/api/v1/health", "acc-1"));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status).toBe(200);
      expect((await res.json()).meta.requestId).toBe("acc-1");
    }
  });

  test("bypassRateLimit outside liveness throws a programmer-error ConfigError", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {},
      "search",
      { bypassRateLimit: true },
    );
    await expect(
      run(req("http://x/api/v1/search?q=x", "bad-1")),
    ).rejects.toThrow(ConfigError);
  });

  test("500 responses carry the limiter decision's header values", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const run = withRequestContext(
      async () => {
        throw new Error("kaboom");
      },
      {
        rateLimit: {
          check: () => ({ allowed: true, limit: 7, remaining: 3, reset }),
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "e-500"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("7");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("3");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String(reset));
    expect(res.headers.get("X-Request-Id")).toBe("e-500");
    expect((await res.json()).error.code).toBe("internal");
  });

  test("hung accounting observes abort after the timeout", async () => {
    let observed: AbortSignal | undefined;
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        usage: {
          record: (_e, options) => {
            observed = options?.signal;
            return new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          },
        },
      },
      "health",
    );
    const res = await run(req("http://x/api/v1/health", "sig-1"));
    expect(res.status).toBe(200);
    // Poll for the abort outcome (bound: 500ms accounting timeout) with a
    // generous deadline instead of a fixed sleep.
    const deadline = Date.now() + 5000;
    while (!observed?.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(observed?.aborted).toBe(true);
  });
});
