import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import {
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
