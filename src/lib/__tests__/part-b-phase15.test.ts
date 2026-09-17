// Phase 15 (Part B): rate limit vs quota vs cache separation.
//
// Pins the four plan invariants plus the cache rules at the seam the phases
// actually share — the pipeline (`withRequestContext`) and `cached()` — with
// no new infra:
//
//   1. a cache HIT through withRequestContext still faces rate-limit +
//      quota charge (unwired data routes are tracked follow-up #34);
//   2. a cache MISS charges usage (even when the admitted response is an error);
//   3. clearCache() never deletes usage_ledger/quota state;
//   4. removing Postgres never breaks Part A transcript serving.
//
// Deliberate residual (see plans/PLAN.md Phase 15): most data routes still
// call handleX() directly instead of going through withRequestContext, so
// these tests pin the pipeline's own order + charge-regardless-of-cache
// semantics rather than end-to-end route wiring. Wiring every route is
// tracked follow-up (#34) with product implications (shared anonymous
// bucket), not Phase 16 batch economics.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleTranscript } from "../../app/api/v1/videos/[id]/transcript/route";
import { type AudioDeps, type ByteRange, handleAudio } from "../audio";
import { cached, cacheGet, cacheSet, clearCache } from "../cache";
import { successResponse } from "../envelope";
import { errorResponse } from "../errors";
import { withRequestContext } from "../pipeline";
import { QUOTA_POLICY_VERSION } from "../quota";
import {
  getBalance,
  InMemoryQuotaStore,
  quotaWindowFor,
  resetQuotaStore,
} from "../quota-accounting";
import {
  PostgresQuotaStore,
  type UsageLedgerRow,
  type UsageLedgerWriter,
} from "../quota-ledger";
import type { RateLimitCheck, RateLimitProvider } from "../rate-limit";
import type { UsageEvent } from "../usage";
import { type BatchDeps, handleBatch, handleQuota } from "../utils";

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": "p15" } });
}

function postReq(url: string, body: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "p15" },
    body,
  });
}

/** Allow-all limiter that records every check (proves the stage ran). */
function recordingAllowLimiter(seen: RateLimitCheck[]): RateLimitProvider {
  return {
    check: (check: RateLimitCheck) => {
      seen.push(check);
      return {
        allowed: true,
        limit: 100,
        remaining: 99,
        reset: Math.floor(Date.now() / 1000) + 60,
      };
    },
  };
}

function denyingLimiter(): RateLimitProvider {
  return {
    check: () => ({
      allowed: false,
      limit: 100,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
      retryAfter: 5,
    }),
  };
}

/** Stub ledger double (same mechanical guarantees as the phase 14 one):
 * balances sum ONLY `accepted` rows; `billing_key` is UNIQUE. */
function stubWriter(seed: UsageLedgerRow[] = []): {
  writer: UsageLedgerWriter;
  rows: UsageLedgerRow[];
} {
  const rows = [...seed];
  return {
    rows,
    writer: {
      sumAccepted: (principal: string, windowId: string) =>
        Promise.resolve(
          rows
            .filter(
              (r) =>
                r.principal === principal &&
                r.windowId === windowId &&
                r.outcome === "accepted",
            )
            .reduce((total, r) => total + r.cost, 0),
        ),
      insert: (row: UsageLedgerRow) => {
        if (!rows.some((r) => r.billingKey === row.billingKey)) {
          rows.push(row);
        }
        return Promise.resolve();
      },
    },
  };
}

let seedCounter = 0;

function acceptedRow(principal: string, windowId: string, cost: number) {
  seedCounter += 1;
  return {
    principal,
    tier: "free",
    operation: "search.query",
    cost,
    policyVersion: QUOTA_POLICY_VERSION,
    windowId,
    outcome: "accepted",
    requestId: `req_p15_seed_${seedCounter}`,
    billingKey: `bk_p15_seed_${seedCounter}`,
  } satisfies UsageLedgerRow;
}

const SEP_NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

const ENV_KEYS = [
  "DATABASE_URL",
  "TUBELENS_QUOTA_DURABLE",
  "TUBELENS_AUDIO_ENABLED",
  "TUBELENS_AUDIO_SECRET",
  "TUBELENS_PUBLIC_URL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearCache();
  resetQuotaStore();
});

// ---------------------------------------------------------------------------
// Invariant 1: a cache hit still faces rate-limit + quota charge.
// ---------------------------------------------------------------------------

describe("phase 15 invariant 1: cache hits still charge", () => {
  test("L0 hit passes the limiter and consumes quota", async () => {
    cacheSet("p15:hit", { v: 1 }, 60_000);
    let fetcherCalls = 0;
    const seen: RateLimitCheck[] = [];
    const events: UsageEvent[] = [];
    const store = new InMemoryQuotaStore();
    const run = withRequestContext(
      async (_r, ctx) => {
        const result = await cached<{ v: number }>(
          "p15:hit",
          60_000,
          async () => {
            fetcherCalls += 1;
            throw new Error("must not run on a hit");
          },
        );
        return successResponse(result.value, {
          requestId: ctx.requestId,
          cached: result.hit,
        });
      },
      {
        rateLimit: recordingAllowLimiter(seen),
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ v: 1 });
    expect(body.meta.cached).toBe(true);
    // The hit never touched upstream, but both gates still ran + charged.
    expect(fetcherCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ endpointClass: "search", cost: 1 });
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "search",
      operation: "search.query",
      cost: 1,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "accepted",
    });
  });

  test("rate-limit denies even on a cache hit; quota untouched", async () => {
    cacheSet("p15:hit-denied", { v: 1 }, 60_000);
    let executions = 0;
    let fetcherCalls = 0;
    const store = new InMemoryQuotaStore();
    const run = withRequestContext(
      async (_r, ctx) => {
        executions += 1;
        const result = await cached<{ v: number }>(
          "p15:hit-denied",
          60_000,
          async () => {
            fetcherCalls += 1;
            throw new Error("must not run");
          },
        );
        return successResponse(result.value, {
          requestId: ctx.requestId,
          cached: result.hit,
        });
      },
      { rateLimit: denyingLimiter(), quotaStore: store },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(executions).toBe(0);
    expect(fetcherCalls).toBe(0);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: a cache miss must charge usage.
// ---------------------------------------------------------------------------

describe("phase 15 invariant 2: cache misses charge", () => {
  test("cold miss runs upstream and consumes quota", async () => {
    let fetcherCalls = 0;
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) => {
        const result = await cached<{ v: number }>(
          "p15:miss",
          60_000,
          async () => {
            fetcherCalls += 1;
            return { v: 2 };
          },
        );
        return successResponse(result.value, {
          requestId: ctx.requestId,
          cached: result.hit,
        });
      },
      {
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(200);
    expect((await res.json()).meta.cached).toBe(false);
    expect(fetcherCalls).toBe(1);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "search",
      cost: 1,
      outcome: "accepted",
    });
  });

  test("admitted error response still consumes (attempt-based, no refund)", async () => {
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) => {
        await cached<{ v: number }>("p15:miss-error", 60_000, async () => ({
          v: 3,
        }));
        return errorResponse(ctx.requestId, {
          code: "upstream_error",
          message: "Upstream failed.",
          hint: "Retry shortly.",
          status: 502,
        });
      },
      {
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "videos.transcript",
    );
    const res = await run(req("http://x/api/v1/videos/abc/transcript"));
    expect(res.status).toBe(502);
    // Weighted cost charged despite the failure...
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(3);
    // ...while the telemetry event honestly reports the rejection.
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "videos.transcript",
      operation: "transcript.get",
      cost: 3,
      outcome: "rejected",
    });
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: clearCache() never deletes usage_ledger/quota state.
// ---------------------------------------------------------------------------

describe("phase 15 invariant 3: clearCache keeps accounting", () => {
  test("L0 entries vanish; ledger rows and quota balances do not", async () => {
    const { windowId } = quotaWindowFor(SEP_NOW);
    const { writer, rows } = stubWriter([
      acceptedRow("user:kept", windowId, 100),
      acceptedRow("user:kept", windowId, 23),
    ]);
    const durable = new PostgresQuotaStore(writer);
    const mem = new InMemoryQuotaStore();
    mem.add("user:cache", windowId, 42);
    cacheSet("p15:probe", { v: 1 }, 60_000);

    const before = await getBalance(durable, "user:kept", "free", SEP_NOW);
    expect(before.used).toBe(123);
    expect(cacheGet("p15:probe")).not.toBeUndefined();

    clearCache();

    expect(cacheGet("p15:probe")).toBeUndefined();
    // Quota state survived: in-memory counters and every ledger row.
    expect(mem.get("user:cache", windowId)).toBe(42);
    expect(rows).toHaveLength(2);
    expect(await getBalance(durable, "user:kept", "free", SEP_NOW)).toEqual(
      before,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: removing Postgres never breaks Part A transcript serving.
// ---------------------------------------------------------------------------

describe("phase 15 invariant 4: transcripts serve without Postgres", () => {
  const segments = [
    { startSeconds: 0, durationSeconds: 2.5, text: "hello" },
    { startSeconds: 2.5, durationSeconds: 3, text: "world" },
  ];

  test("serves with DATABASE_URL unset", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.TUBELENS_QUOTA_DURABLE;
    const res = await handleTranscript(
      req("http://x/api/v1/videos/p15trscAAAA/transcript"),
      "p15trscAAAA",
      { fetchNative: async () => segments },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(segments);
  });

  test("serves with durable accounting requested but the DB unreachable", async () => {
    // The transcript path never consults the quota store/ledger, so even a
    // half-configured durable mode cannot break it.
    process.env.TUBELENS_QUOTA_DURABLE = "1";
    process.env.DATABASE_URL = "postgres://unreachable.invalid:5432/x";
    const res = await handleTranscript(
      req("http://x/api/v1/videos/p15trscAAAB/transcript"),
      "p15trscAAAB",
      { fetchNative: async () => segments },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(segments);
  });
});

// ---------------------------------------------------------------------------
// Cache rules: quota/batch/audio are private, no-store; stale sets
// meta.cached + warnings[]. Transcripts stay out of Postgres (invariant 4).
// ---------------------------------------------------------------------------

describe("phase 15 cache rules", () => {
  test("quota balance reads are private, no-store", async () => {
    const res = await handleQuota(req("http://x/api/v1/quota"), {
      store: new InMemoryQuotaStore(),
      identity: "user:p15",
      nowMs: SEP_NOW,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("batch responses are private, no-store", async () => {
    // The fan-out pins to a trusted origin (never the request Host).
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    const deps: BatchDeps = {
      execute: async () => ({ status: 200, body: { ok: true } }),
    };
    const res = await handleBatch(
      postReq(
        "http://x/api/v1/batch",
        JSON.stringify({
          requests: [{ method: "GET", path: "/api/v1/health" }],
        }),
      ),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("audio JSON + bytes modes are private, no-store", async () => {
    process.env.TUBELENS_AUDIO_ENABLED = "1";
    process.env.TUBELENS_AUDIO_SECRET = "p15-test-secret";
    const total = 1000;
    const full = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) {
      full[i] = i % 256;
    }
    const deps: AudioDeps = {
      fetchFormat: async () => ({
        mimeType: "audio/webm",
        bitrate: 128000,
        contentLength: total,
      }),
      fetchRange: async (_id: string, range: ByteRange | null) => {
        const start = range?.start ?? 0;
        const end = range?.end ?? total - 1;
        return {
          bytes: full.slice(start, Math.min(end, total - 1) + 1),
          contentType: "audio/webm",
          totalLength: total,
          partial: range !== null,
        };
      },
    };
    const vid = "dQw4w9WgXcQ";
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${vid}/audio`),
      vid,
      deps,
    );
    expect(signed.status).toBe(200);
    expect(signed.headers.get("Cache-Control")).toBe("private, no-store");
    const { url } = (await signed.json()).data as { url: string };
    const bytes = await handleAudio(req(url), vid, deps);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("serve-stale-on-error sets meta.cached + warnings[]", async () => {
    const id = "p15trscAAAC";
    const segments = [{ startSeconds: 0, durationSeconds: 2, text: "stale" }];
    cacheSet(`transcript:v1:${id}:en`, segments, -1, 60 * 60 * 1000);
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      {
        fetchNative: async () => {
          throw new Error("429 Too Many Requests");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(segments);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });
});

// ---------------------------------------------------------------------------
// Separation gates: neither subsystem is the other's source of truth.
// ---------------------------------------------------------------------------

describe("phase 15 separation gates", () => {
  test("rate-limit deny wins with full quota; quota untouched", async () => {
    let executions = 0;
    const store = new InMemoryQuotaStore();
    const run = withRequestContext(
      async (_r, ctx) => {
        executions += 1;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      { rateLimit: denyingLimiter(), quotaStore: store },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(executions).toBe(0);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(0);
  });

  test("exhausted quota rejects after the limiter allowed; handler never runs", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(Date.now());
    await store.add("anonymous", windowId, 10_000);
    const seen: RateLimitCheck[] = [];
    let executions = 0;
    const run = withRequestContext(
      async (_r, ctx) => {
        executions += 1;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      { rateLimit: recordingAllowLimiter(seen), quotaStore: store },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("quota_exceeded");
    // The limiter still ran first (its own gate), the handler never did, and
    // the rejection consumed nothing.
    expect(seen).toHaveLength(1);
    expect(executions).toBe(0);
    expect(await store.get("anonymous", windowId)).toBe(10_000);
  });
});
