// Phase 12 (Part B): distributed Redis rate-limit engine.
//
// Proves burst + sustained sliding windows, per-principal/per-class
// isolation, cost weighting + caps, shared enforcement across two provider
// instances on one backend (including a concurrent burst admitting exactly
// the limit), principal stability across client labels, the 429 pipeline
// contract, unconfigured allow-all fallback, singleton rotation, and
// fail-closed behavior — all against a minimal in-memory test double
// implementing `eval` with the exact semantics of RATE_LIMIT_LUA_SCRIPT
// (one atomic trim→count→conditional-add per call). A live-Upstash test
// runs only when both UPSTASH_* env vars are present, else it is skipped
// (never fails CI without creds).

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";
import { FREE_ENTITLEMENTS } from "../product";
import {
  allowAllRateLimitProvider,
  createRedisRateLimitProvider,
  getRateLimitProvider,
  isPoisonProvider,
  RATE_LIMIT_BURST_LIMIT,
  RATE_LIMIT_BURST_WINDOW_MS,
  RATE_LIMIT_LUA_SCRIPT,
  RATE_LIMIT_POLICY_VERSION,
  RATE_LIMIT_SUSTAINED_LIMIT,
  RATE_LIMIT_SUSTAINED_WINDOW_MS,
  type RateLimitRedisBackend,
  resetRateLimitProvider,
  sanitizeRateLimitKeyPart,
  upstashRateLimitBackend,
} from "../rate-limit";
import { buildRequestContext } from "../request-context";

function req(url: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, { headers });
}

// ---------------------------------------------------------------------------
// In-memory test double: implements `eval` with the EXACT semantics of
// RATE_LIMIT_LUA_SCRIPT (rejects any other script). State mutation runs
// synchronously inside the call — no awaits — so concurrent checks
// serialize exactly like a real atomic Lua execution. Time is driven by
// the provider's injected `now`, so window expiry needs no sleeps. TTLs
// are a recorded no-op: trimming by score covers expiry in tests.
// ---------------------------------------------------------------------------

class InMemoryRateLimitBackend implements RateLimitRedisBackend {
  private sets = new Map<string, Array<{ score: number; member: string }>>();

  /** How many script evaluations ran (proves no backend contact, etc.). */
  evalCalls = 0;

  /** Inspect raw members of one window key (key-shape assertions). */
  members(key: string): string[] {
    return (this.sets.get(key) ?? []).map((entry) => entry.member);
  }

  /** All window keys created so far. */
  keys(): string[] {
    return [...this.sets.keys()];
  }

  private entry(key: string): Array<{ score: number; member: string }> {
    let list = this.sets.get(key);
    if (!list) {
      list = [];
      this.sets.set(key, list);
    }
    return list;
  }

  async eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    this.evalCalls += 1;
    if (script !== RATE_LIMIT_LUA_SCRIPT) {
      throw new Error("Rate-limit backend unavailable.");
    }
    if (
      !Array.isArray(keys) ||
      keys.length !== 2 ||
      typeof keys[0] !== "string" ||
      typeof keys[1] !== "string" ||
      !Array.isArray(args) ||
      args.length !== 9
    ) {
      throw new Error("Rate-limit backend unavailable.");
    }
    const [
      nowMs,
      burstWindowMs,
      burstLimit,
      sustainedWindowMs,
      sustainedLimit,
      cost,
      nonce,
      _burstTtl,
      _sustainedTtl,
    ] = args;
    if (
      typeof nowMs !== "number" ||
      typeof burstWindowMs !== "number" ||
      typeof burstLimit !== "number" ||
      typeof sustainedWindowMs !== "number" ||
      typeof sustainedLimit !== "number" ||
      typeof cost !== "number" ||
      !Number.isInteger(cost) ||
      cost < 1 ||
      typeof nonce !== "string"
    ) {
      throw new Error("Rate-limit backend unavailable.");
    }
    const [burstKey, sustainedKey] = keys;
    // Atomic section: synchronous from here to return (mirrors Lua).
    const trim = (key: string, windowMs: number): void => {
      const list = this.entry(key);
      this.sets.set(
        key,
        list.filter((entry) => entry.score > nowMs - windowMs),
      );
    };
    trim(burstKey, burstWindowMs);
    trim(sustainedKey, sustainedWindowMs);
    const burstList = this.entry(burstKey);
    const sustainedList = this.entry(sustainedKey);
    const oldest = (list: Array<{ score: number; member: string }>): number => {
      let min = Number.POSITIVE_INFINITY;
      for (const entry of list) {
        if (entry.score < min) {
          min = entry.score;
        }
      }
      return min === Number.POSITIVE_INFINITY ? nowMs : min;
    };
    // Freeing member: the (count + cost - limit)-th oldest — the slot
    // whose expiry actually frees enough room (mirrors the Lua helper).
    const freeing = (
      list: Array<{ score: number; member: string }>,
      need: number,
    ): number => {
      if (need < 1) {
        return nowMs;
      }
      const sorted = [...list].sort((a, b) => a.score - b.score);
      return sorted.length >= need ? sorted[need - 1].score : nowMs;
    };
    const burstOldest = oldest(burstList);
    const sustainedOldest = oldest(sustainedList);
    const burstDenied = burstList.length + cost > burstLimit;
    const sustainedDenied = sustainedList.length + cost > sustainedLimit;
    if (burstDenied || sustainedDenied) {
      return [
        0,
        burstList.length,
        burstDenied
          ? freeing(burstList, burstList.length + cost - burstLimit)
          : burstOldest,
        sustainedList.length,
        sustainedDenied
          ? freeing(sustainedList, sustainedList.length + cost - sustainedLimit)
          : sustainedOldest,
      ];
    }
    for (let i = 1; i <= cost; i += 1) {
      burstList.push({ score: nowMs, member: `${nonce}:b:${i}` });
      sustainedList.push({ score: nowMs, member: `${nonce}:s:${i}` });
    }
    return [
      1,
      burstList.length,
      burstOldest,
      sustainedList.length,
      sustainedOldest,
    ];
  }
}

function failingBackend(reason: string): RateLimitRedisBackend {
  return {
    eval(): Promise<unknown> {
      throw new Error(reason);
    },
  };
}

function replyBackend(reply: unknown): RateLimitRedisBackend {
  return {
    eval: () => Promise.resolve(reply),
  };
}

/** Controllable clock — window expiry without sleeps. */
function clock(startMs = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const savedRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const savedRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  resetRateLimitProvider();
  if (savedRedisUrl === undefined) {
    delete process.env.UPSTASH_REDIS_REST_URL;
  } else {
    process.env.UPSTASH_REDIS_REST_URL = savedRedisUrl;
  }
  if (savedRedisToken === undefined) {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  } else {
    process.env.UPSTASH_REDIS_REST_TOKEN = savedRedisToken;
  }
});

function clearRedisEnv(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

describe("centralized rate-limit policy (Phase 12)", () => {
  test("burst is 60 requests / 10s; sustained is 100 / 60s", () => {
    expect(RATE_LIMIT_BURST_LIMIT).toBe(60);
    expect(RATE_LIMIT_BURST_WINDOW_MS).toBe(10_000);
    expect(RATE_LIMIT_SUSTAINED_LIMIT).toBe(100);
    expect(RATE_LIMIT_SUSTAINED_WINDOW_MS).toBe(60_000);
    expect(RATE_LIMIT_POLICY_VERSION).toMatch(/^20\d\d-/);
  });

  test("invalid factory windows fail closed at construction", () => {
    const backend = new InMemoryRateLimitBackend();
    expect(() =>
      createRedisRateLimitProvider(backend, { burst: { limit: 0 } }),
    ).toThrow();
    expect(() =>
      createRedisRateLimitProvider(backend, { sustained: { windowMs: -5 } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Burst window
// ---------------------------------------------------------------------------

describe("burst sliding window (Phase 12)", () => {
  test("allows up to the burst limit then denies with retryAfter>=1", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 3, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    const first = await provider.check({ identity: "user:u1" });
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    expect(await provider.check({ identity: "user:u1" })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await provider.check({ identity: "user:u1" })).toMatchObject({
      allowed: true,
      remaining: 0,
    });

    const denied = await provider.check({ identity: "user:u1" });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Stable headers: even a burst-driven deny reports the sustained limit;
    // the binding constraint surfaces via reset/retryAfter only.
    expect(denied.limit).toBe(1000);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
    expect(denied.reset).toBeGreaterThan(Math.floor(time.now() / 1000));
    // Reset ≈ oldest entry + burst window (sliding, not fixed).
    expect(denied.reset).toBe(Math.floor((time.now() + 10_000) / 1000));
  });

  test("window expiry restores allowance without any sleep", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 1, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    expect((await provider.check({ identity: "user:u1" })).allowed).toBe(true);
    expect((await provider.check({ identity: "user:u1" })).allowed).toBe(false);
    time.advance(10_001);
    const after = await provider.check({ identity: "user:u1" });
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sustained window + isolation
// ---------------------------------------------------------------------------

describe("sustained window and isolation (Phase 12)", () => {
  test("sustained cap denies while burst still has room", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 1000, windowMs: 10_000 },
      sustained: { limit: 2, windowMs: 60_000 },
      now: time.now,
    });

    expect((await provider.check({ identity: "user:u1" })).allowed).toBe(true);
    expect((await provider.check({ identity: "user:u1" })).allowed).toBe(true);
    const denied = await provider.check({ identity: "user:u1" });
    expect(denied.allowed).toBe(false);
    // Stable headers still hold (sustained limit), with a long sustained
    // retryAfter proving the sustained window is the binding constraint.
    expect(denied.limit).toBe(2);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("endpoint classes are isolated per identity", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 1, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    expect(
      (await provider.check({ identity: "user:u1", endpointClass: "search" }))
        .allowed,
    ).toBe(true);
    expect(
      (await provider.check({ identity: "user:u1", endpointClass: "search" }))
        .allowed,
    ).toBe(false);
    expect(
      (
        await provider.check({
          identity: "user:u1",
          endpointClass: "transcript",
        })
      ).allowed,
    ).toBe(true);
  });

  test("identities are isolated per endpoint class", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 1, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    expect((await provider.check({ identity: "user:aaa" })).allowed).toBe(true);
    expect((await provider.check({ identity: "user:aaa" })).allowed).toBe(
      false,
    );
    expect((await provider.check({ identity: "user:bbb" })).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost weighting
// ---------------------------------------------------------------------------

describe("cost weighting (Phase 12, reserved for Phase 13 credits)", () => {
  test("cost=3 consumes three slots", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 5, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    const first = await provider.check({ identity: "user:u1", cost: 3 });
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    // 3 used + 3 more = 6 > 5 → denied.
    const denied = await provider.check({ identity: "user:u1", cost: 3 });
    expect(denied).toMatchObject({ allowed: false, remaining: 0 });
    // But a cost-1 request still fits (3 + 1 <= 5).
    expect(
      await provider.check({ identity: "user:u1", cost: 1 }),
    ).toMatchObject({ allowed: true, remaining: 1 });
  });

  test("non-positive cost fails closed", async () => {
    const provider = createRedisRateLimitProvider(
      new InMemoryRateLimitBackend(),
    );
    await expect(
      provider.check({ identity: "user:u1", cost: 0 }),
    ).rejects.toThrow();
    await expect(
      provider.check({ identity: "user:u1", cost: Number.NaN }),
    ).rejects.toThrow();
  });

  test("absurd cost fails closed before any backend contact", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 5, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    // A single request can never exceed the burst window — rejected
    // without building a giant write (evalCalls stays 0).
    await expect(
      provider.check({ identity: "user:u1", cost: 1e9 }),
    ).rejects.toThrow();
    await expect(
      provider.check({ identity: "user:u1", cost: 6 }),
    ).rejects.toThrow();
    expect(backend.evalCalls).toBe(0);
    // Cost exactly at the burst limit still works.
    const exact = await provider.check({ identity: "user:u1", cost: 5 });
    expect(exact).toMatchObject({ allowed: true, remaining: 0 });
    expect(backend.evalCalls).toBe(1);
  });

  test("weighted deny reset tracks the freeing member; cost-1 stays oldest-based", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 5, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });
    const check = { identity: "user:weighted" };
    // Seed 5 staggered slots: t0, t0+1s, …, t0+4s; now ends at t0+5s.
    for (let i = 0; i < 5; i += 1) {
      expect((await provider.check(check)).allowed).toBe(true);
      time.advance(1000);
    }
    const t0 = 1_700_000_000_000;
    // cost=3 with 5 used of 5 needs 3 slots free: the 3rd-oldest member
    // (t0+2s) is the freeing slot — NOT the oldest (t0).
    const denied = await provider.check({ ...check, cost: 3 });
    expect(denied.allowed).toBe(false);
    expect(denied.reset).toBe(Math.floor((t0 + 2000 + 10_000) / 1000));
    expect(denied.retryAfter).toBe(
      Math.floor((t0 + 2000 + 10_000) / 1000) - Math.floor((t0 + 5000) / 1000),
    );
    // cost:1 (the pipeline's path) still keys off the oldest member.
    const deniedOne = await provider.check(check);
    expect(deniedOne.allowed).toBe(false);
    expect(deniedOne.reset).toBe(Math.floor((t0 + 10_000) / 1000));
    expect(deniedOne.retryAfter).toBe(
      Math.floor((t0 + 10_000) / 1000) - Math.floor((t0 + 5000) / 1000),
    );
  });

  test("malformed script replies fail closed with the static message", async () => {
    const time = clock();
    const nowMs = time.now();
    const valid = [1, 1, nowMs, 1, nowMs];
    for (const reply of [
      "oops",
      null,
      42,
      [1, 1],
      [1, 1, nowMs, 1],
      [1, 1, nowMs, 1, nowMs, 99],
      [2, 0, nowMs, 0, nowMs],
      [1, "1", nowMs, 1, nowMs],
      [1, 1, "yesterday", 1, nowMs],
      [1, -1, nowMs, 0, nowMs],
      [1, Number.NaN, nowMs, 0, nowMs],
      [0, 3, nowMs, 0, Number.POSITIVE_INFINITY],
    ]) {
      const provider = createRedisRateLimitProvider(replyBackend(reply), {
        now: time.now,
      });
      let message = "resolved";
      try {
        await provider.check({ identity: "user:u1" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Rate-limit backend unavailable.");
    }
    // Sanity: the valid shape is accepted.
    const ok = await createRedisRateLimitProvider(replyBackend(valid), {
      now: time.now,
    }).check({ identity: "user:u1" });
    expect(ok.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Distributed proof: two instances, one backend, one shared limit
// ---------------------------------------------------------------------------

describe("distributed shared limit (Phase 12)", () => {
  test("two provider instances on one backend enforce a single limit", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const options = {
      burst: { limit: 4, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    };
    const instanceA = createRedisRateLimitProvider(backend, options);
    const instanceB = createRedisRateLimitProvider(backend, options);

    const check = { identity: "user:shared", endpointClass: "search" };
    let allows = 0;
    for (const instance of [instanceA, instanceB, instanceA, instanceB]) {
      if ((await instance.check(check)).allowed) {
        allows += 1;
      }
    }
    expect(allows).toBe(4);
    // The 5th request is denied no matter which instance serves it.
    expect((await instanceA.check(check)).allowed).toBe(false);
    expect((await instanceB.check(check)).allowed).toBe(false);
  });

  test("a concurrent burst across two instances admits exactly the limit", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const options = {
      burst: { limit: 4, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    };
    const instanceA = createRedisRateLimitProvider(backend, options);
    const instanceB = createRedisRateLimitProvider(backend, options);
    const check = { identity: "user:race", endpointClass: "search" };
    // All in flight at once: with a non-atomic read-then-write this would
    // over-admit; the atomic script admits exactly 4.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? instanceA : instanceB).check(check),
      ),
    );
    expect(results.filter((d) => d.allowed).length).toBe(4);
    expect(results.filter((d) => !d.allowed).length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Principal stability: same identity, different client labels
// ---------------------------------------------------------------------------

describe("principal-scoped enforcement (Phase 12)", () => {
  test("same identity under different client labels shares one limit", async () => {
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 2, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });

    // Two "clients" (different code paths/labels) acting as the same
    // authed principal resolve to the same identity string — switching
    // clients must not mint a fresh bucket.
    const fromClientA = { identity: "user:user_1", endpointClass: "default" };
    const fromClientB = { identity: "user:user_1", endpointClass: "default" };
    expect((await provider.check(fromClientA)).allowed).toBe(true);
    expect((await provider.check(fromClientB)).allowed).toBe(true);
    expect((await provider.check(fromClientA)).allowed).toBe(false);
    // A different principal is unaffected.
    expect((await provider.check({ identity: "user:user_2" })).allowed).toBe(
      true,
    );
  });

  test("request context pins the limiter identity to the principal, not the client", () => {
    const auth = {
      type: "user",
      authenticated: true,
      userId: "user_1",
      tier: "free",
      role: "user",
    } as const;
    const inputs = {
      auth,
      tier: "free" as const,
      entitlements: FREE_ENTITLEMENTS,
    };
    const viaClientA = buildRequestContext(
      new Request("http://x/api/v1/search", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      }),
      inputs,
    );
    const viaClientB = buildRequestContext(
      new Request("http://x/api/v1/search", {
        headers: { "x-forwarded-for": "10.9.9.9" },
      }),
      inputs,
    );
    expect(viaClientA.rateLimitIdentity).toBe("user:user_1");
    expect(viaClientB.rateLimitIdentity).toBe(viaClientA.rateLimitIdentity);
  });
});

// ---------------------------------------------------------------------------
// 429 contract through the pipeline
// ---------------------------------------------------------------------------

describe("429 contract through withRequestContext (Phase 12)", () => {
  test("denying provider yields 429 + rate_limited + Retry-After + X-RateLimit-*", async () => {
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        rateLimit: {
          check: () => ({
            allowed: false,
            limit: 7,
            remaining: 0,
            reset: 12345,
            retryAfter: 9,
          }),
        },
      },
      "search",
    );
    const res = await run(req("http://x/api/v1/search", "rl-429-1"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("7");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("12345");
    expect(res.headers.get("X-Request-Id")).toBe("rl-429-1");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------
// Provider selection + failure policy + sanitization
// ---------------------------------------------------------------------------

describe("provider selection and failure policy (Phase 12)", () => {
  test("unconfigured env returns the allow-all default (wire contract)", async () => {
    clearRedisEnv();
    resetRateLimitProvider();
    expect(getRateLimitProvider()).toBe(allowAllRateLimitProvider);
    const decision = await getRateLimitProvider().check({ identity: "anon:x" });
    expect(decision).toMatchObject({
      allowed: true,
      limit: 100,
      remaining: 99,
    });
  });

  test("blank env values count as unconfigured", () => {
    process.env.UPSTASH_REDIS_REST_URL = "   ";
    process.env.UPSTASH_REDIS_REST_TOKEN = "";
    resetRateLimitProvider();
    expect(getRateLimitProvider()).toBe(allowAllRateLimitProvider);
  });

  test("configured env returns a shared Redis-backed singleton", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    resetRateLimitProvider();
    const first = getRateLimitProvider();
    const second = getRateLimitProvider();
    expect(first).not.toBe(allowAllRateLimitProvider);
    // Discriminates against the poison fallback (no network in tests, so
    // check() itself is never invoked against the dummy URL).
    expect(isPoisonProvider(first)).toBe(false);
    expect(second).toBe(first);
    resetRateLimitProvider();
    clearRedisEnv();
    expect(getRateLimitProvider()).toBe(allowAllRateLimitProvider);
  });

  test("singleton rebuilds when credentials rotate", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://a.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok-a";
    resetRateLimitProvider();
    const first = getRateLimitProvider();
    expect(getRateLimitProvider()).toBe(first);
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok-b";
    const second = getRateLimitProvider();
    expect(second).not.toBe(first);
    expect(second).not.toBe(allowAllRateLimitProvider);
    process.env.UPSTASH_REDIS_REST_URL = "https://b.upstash.io";
    const third = getRateLimitProvider();
    expect(third).not.toBe(second);
    expect(third).not.toBe(allowAllRateLimitProvider);
  });

  test("throwing backend normalizes to the static message (pipeline 503)", async () => {
    const provider = createRedisRateLimitProvider(failingBackend("redis down"));
    let message = "resolved";
    try {
      await provider.check({ identity: "user:u1" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Rate-limit backend unavailable.");
    expect(message).not.toContain("redis down");
  });

  test("rejecting eval throws the static message without leaking keys", async () => {
    const backend: RateLimitRedisBackend = {
      eval: () => Promise.reject(new Error("connection refused")),
    };
    const provider = createRedisRateLimitProvider(backend);
    let failure: unknown = null;
    try {
      await provider.check({ identity: "user:u1" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Rate-limit backend unavailable.");
    expect((failure as Error).message).not.toContain("user:u1");
  });
});

describe("key sanitization (Phase 12)", () => {
  test("strips control chars, braces, and glob stars; bounds length", () => {
    expect(sanitizeRateLimitKeyPart("user:user_1")).toBe("user_user_1");
    expect(sanitizeRateLimitKeyPart("a{b}c*d")).toBe("abcd");
    expect(sanitizeRateLimitKeyPart("a\x00b\x1Fc\x7Fd")).toBe("abcd");
    expect(
      sanitizeRateLimitKeyPart("x".repeat(500)).length,
    ).toBeLessThanOrEqual(128);
  });

  test("colons are neutralized so key structure cannot collide", async () => {
    expect(sanitizeRateLimitKeyPart("a:b")).toBe("a_b");
    // ("a:b","c") vs ("a","b:c") shared one key before neutralization.
    const backend = new InMemoryRateLimitBackend();
    const time = clock();
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 1, windowMs: 10_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      now: time.now,
    });
    expect(
      (await provider.check({ identity: "a:b", endpointClass: "c" })).allowed,
    ).toBe(true);
    // Separate bucket — still allowed, not a collision.
    expect(
      (await provider.check({ identity: "a", endpointClass: "b:c" })).allowed,
    ).toBe(true);
    // And the first bucket is indeed exhausted on its own.
    expect(
      (await provider.check({ identity: "a:b", endpointClass: "c" })).allowed,
    ).toBe(false);
    expect(backend.keys().sort()).toEqual([
      "rl:v1:a:b_c:burst",
      "rl:v1:a:b_c:sustained",
      "rl:v1:a_b:c:burst",
      "rl:v1:a_b:c:sustained",
    ]);
  });

  test("empty identity or endpoint class fails closed", async () => {
    const provider = createRedisRateLimitProvider(
      new InMemoryRateLimitBackend(),
    );
    await expect(provider.check({ identity: "" })).rejects.toThrow();
    await expect(provider.check({ identity: "   " })).rejects.toThrow();
    await expect(
      provider.check({ identity: "user:u1", endpointClass: "" }),
    ).rejects.toThrow();
    // Nothing but injection chars → empty after sanitize → throw.
    await expect(provider.check({ identity: "{*}**" })).rejects.toThrow();
  });

  test("window keys stay namespaced under rl:v1", async () => {
    const backend = new InMemoryRateLimitBackend();
    const provider = createRedisRateLimitProvider(backend, {
      now: clock().now,
    });
    await provider.check({ identity: "user:u1", endpointClass: "search" });
    const keys = backend.keys().sort();
    expect(keys).toEqual([
      "rl:v1:user_u1:search:burst",
      "rl:v1:user_u1:search:sustained",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live Upstash integration (only with credentials; skipped otherwise).
// ---------------------------------------------------------------------------

const hasLiveCreds =
  typeof process.env.UPSTASH_REDIS_REST_URL === "string" &&
  process.env.UPSTASH_REDIS_REST_URL.trim() !== "" &&
  typeof process.env.UPSTASH_REDIS_REST_TOKEN === "string" &&
  process.env.UPSTASH_REDIS_REST_TOKEN.trim() !== "" &&
  process.env.UPSTASH_REDIS_REST_URL !== "https://example.upstash.io";

if (hasLiveCreds) {
  test("live Upstash enforces a shared burst limit (Phase 12)", async () => {
    const { Redis } = await import("@upstash/redis");
    const backend = upstashRateLimitBackend(
      new Redis({
        url: (process.env.UPSTASH_REDIS_REST_URL as string).trim(),
        token: (process.env.UPSTASH_REDIS_REST_TOKEN as string).trim(),
      }),
    );
    const identity = `phase12-live:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
    const provider = createRedisRateLimitProvider(backend, {
      burst: { limit: 3, windowMs: 60_000 },
      sustained: { limit: 1000, windowMs: 60_000 },
      timeoutMs: 8000,
    });
    expect((await provider.check({ identity })).allowed).toBe(true);
    expect((await provider.check({ identity })).allowed).toBe(true);
    expect((await provider.check({ identity })).allowed).toBe(true);
    const denied = await provider.check({ identity });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });
} else {
  test.skip("live Upstash enforces a shared burst limit (needs UPSTASH_* creds)", () => {});
}
