// Phase 16 (Part B): batch protection and partial-abuse resistance.
//
// Proves the batch route's bounded economics end to end: preflight-priced
// admission through withRequestContext (one summed quota/rate-limit charge,
// peek-once/consume-once), hard reject-before-work gates (child count +
// total cost + remaining credits) with zero child invocations, frozen
// partial-failure semantics (admitted batches always 200 with per-child
// isolation, never whole-batch 502), retry as a new full-cost attempt with
// a fresh server-minted billing key, and exactly one usage row per batch.

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  createBatchHandler,
  defaultBatchDeps,
} from "../../app/api/v1/batch/route";
import { anonymousAuthContext } from "../auth";
import {
  BATCH_CHILD_HEADER,
  getBatchMarkerSecret,
  mintBatchChildMarker,
  verifyBatchChildMarker,
} from "../batch-marker";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";
import {
  BATCH_MAX_COST,
  QUOTA_POLICY_VERSION,
  resolveBatchChildRoute,
} from "../quota";
import { InMemoryQuotaStore, quotaWindowFor } from "../quota-accounting";
import type { RateLimitCheck } from "../rate-limit";
import type { UsageEvent } from "../usage";
import type { BatchDeps, BatchSubResult, BatchTask } from "../utils";
import { demoteUnpriceableBatchTasks } from "../utils";

const savedOrigin = process.env.TUBELENS_PUBLIC_URL;
const savedMarkerKey = process.env.TUBELENS_BATCH_HMAC_KEY;
afterEach(() => {
  if (savedOrigin === undefined) {
    delete process.env.TUBELENS_PUBLIC_URL;
  } else {
    process.env.TUBELENS_PUBLIC_URL = savedOrigin;
  }
  if (savedMarkerKey === undefined) {
    delete process.env.TUBELENS_BATCH_HMAC_KEY;
  } else {
    process.env.TUBELENS_BATCH_HMAC_KEY = savedMarkerKey;
  }
});

function postReq(
  body: unknown,
  requestId = "p16",
  raw = false,
  extraHeaders?: Record<string, string>,
): NextRequest {
  return new NextRequest("http://x/api/v1/batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(extraHeaders ?? {}),
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/** Deferred usage telemetry lands in a macrotask; flush before asserting. */
async function flushAccounting(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

interface Sut {
  run: (req: NextRequest) => Promise<Response>;
  store: InMemoryQuotaStore;
  events: UsageEvent[];
  rateChecks: RateLimitCheck[];
  executions: () => number;
  /** Per-execution extra headers (credentials + marker) seen by the mock. */
  extras: () => Array<Record<string, string>>;
}

function makeSut(
  execute?: BatchDeps["execute"],
  env?: Record<string, string | undefined>,
): Sut {
  process.env.TUBELENS_PUBLIC_URL = "http://x";
  const store = new InMemoryQuotaStore();
  const events: UsageEvent[] = [];
  const rateChecks: RateLimitCheck[] = [];
  const seenExtras: Array<Record<string, string>> = [];
  let calls = 0;
  const deps: BatchDeps = {
    execute: execute
      ? async (url, requestId, signal, extraHeaders) => {
          calls += 1;
          seenExtras.push({ ...(extraHeaders ?? {}) });
          return execute(url, requestId, signal, extraHeaders);
        }
      : async (_url, _requestId, _signal, extraHeaders) => {
          calls += 1;
          seenExtras.push({ ...(extraHeaders ?? {}) });
          return { status: 200, body: { ok: true } };
        },
  };
  const run = createBatchHandler(deps, {
    // Explicit anonymous auth + empty env: hermetic regardless of global
    // overrides or host enforcement/secret configuration.
    auth: { resolve: async () => ({ ...anonymousAuthContext }) },
    env: env ?? {},
    quotaStore: store,
    rateLimit: {
      check: (check: RateLimitCheck) => {
        rateChecks.push(check);
        return {
          allowed: true,
          limit: 100,
          remaining: 99,
          reset: Math.floor(Date.now() / 1000) + 60,
        };
      },
    },
    usage: {
      record: (event: UsageEvent) => {
        events.push(event);
      },
    },
  });
  return {
    run,
    store,
    events,
    rateChecks,
    executions: () => calls,
    extras: () => seenExtras,
  };
}

/** health(1) + search(1) + transcript(3) = summed cost 5. */
function cheapMixedBody(): unknown {
  return {
    requests: [
      { method: "GET", path: "/api/v1/health" },
      { method: "GET", path: "/api/v1/search?q=lofi" },
      { method: "GET", path: "/api/v1/videos/abc123/transcript" },
    ],
  };
}

describe("phase 16 admitted batch: single summed charge", () => {
  test("valid batch within limits → 200 admitted, one charge, one usage row", async () => {
    const sut = makeSut();
    const res = await sut.run(postReq(cheapMixedBody(), "p16-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Request-Id")).toBe("p16-1");
    expect(res.headers.get("X-RateLimit-Limit")).not.toBeNull();
    const body = await res.json();
    expect(body.data.results).toHaveLength(3);
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("p16-1");
    expect(body.warnings).toEqual([]);

    // Peek once, consume once: the summed cost hits the store exactly once.
    expect(sut.executions()).toBe(3);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(5);

    // Single rate-limit weight = summed cost, not per-child admissions.
    expect(sut.rateChecks).toHaveLength(1);
    expect(sut.rateChecks[0]).toMatchObject({
      endpointClass: "batch",
      cost: 5,
    });

    // Exactly one usage row: summed cost + child summary + policy version.
    await flushAccounting();
    expect(sut.events).toHaveLength(1);
    expect(sut.events[0]).toMatchObject({
      route: "batch",
      operation: "batch.execute",
      cost: 5,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "accepted",
    });
    expect(sut.events[0]?.children).toHaveLength(3);
  });
});

describe("phase 16 reject-before-work gates", () => {
  test("11 children → invalid_batch, zero child calls, zero charge", async () => {
    const sut = makeSut();
    const res = await sut.run(
      postReq({
        requests: Array.from({ length: 11 }, () => ({
          method: "GET",
          path: "/api/v1/health",
        })),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.error.code)).toBe("invalid_batch");
    expect(sut.executions()).toBe(0);
    expect(sut.rateChecks).toHaveLength(0);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(0);
    await flushAccounting();
    expect(sut.events).toHaveLength(0);
  });

  test("malformed body → invalid_batch, zero child calls", async () => {
    const sut = makeSut();
    const res = await sut.run(postReq("not json{{{", "p16-bad", true));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.error.code)).toBe("invalid_batch");
    expect(sut.executions()).toBe(0);
  });

  test("mixed cheap/expensive over ceiling → batch_cost_exceeded, zero child calls", async () => {
    const sut = makeSut();
    // 4 × transcript (12) + 3 × combined (12) = 24 > ceiling 20.
    const requests = [
      ...Array.from({ length: 4 }, (_, i) => ({
        method: "GET",
        path: `/api/v1/videos/v${i}/transcript`,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        method: "GET",
        path: `/api/v1/videos/c${i}/combined`,
      })),
    ];
    const res = await sut.run(postReq({ requests }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("batch_cost_exceeded");
    expect(body.error.hint).toContain(String(BATCH_MAX_COST));
    expect(sut.executions()).toBe(0);
    expect(sut.rateChecks).toHaveLength(0);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(0);
    await flushAccounting();
    expect(sut.events).toHaveLength(0);
  });

  test("cost over remaining credits → 429 quota_exceeded, zero child calls, consuming nothing", async () => {
    const sut = makeSut();
    const { windowId } = quotaWindowFor(Date.now());
    await sut.store.add("anonymous", windowId, 9996);
    const res = await sut.run(postReq(cheapMixedBody()));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.hint.length).toBeGreaterThan(5);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    // No child ran, nothing consumed — the store total is untouched.
    expect(sut.executions()).toBe(0);
    expect(await sut.store.get("anonymous", windowId)).toBe(9996);
    // The single rejected row is telemetry (outcome rejected), not a charge.
    expect(sut.events).toHaveLength(1);
    expect(sut.events[0]).toMatchObject({
      route: "batch",
      operation: "batch.execute",
      cost: 5,
      outcome: "rejected",
    });
    expect(sut.events[0]?.children).toHaveLength(3);
  });
});

describe("phase 16 retry and partial semantics", () => {
  test("retry same body → deterministic verdict + full re-charge", async () => {
    const sut = makeSut();
    const body = {
      requests: [
        { method: "GET", path: "/api/v1/health" },
        { method: "GET", path: "/api/v1/search?q=lofi" },
      ],
    };
    // Same client-echoed X-Request-Id twice: each admitted attempt is a new
    // full-cost charge. The store total IS the distinct-billingKey proof:
    // InMemoryQuotaStore dedupes retried consumes sharing one server-minted
    // key (ON CONFLICT DO NOTHING semantics), so a total of 4 proves the
    // pipeline minted a fresh key per attempt instead of deriving it from
    // the replayed X-Request-Id (which would have left the total at 2).
    // Verdict equality holds here because the mock executor is
    // deterministic; live upstream results may legitimately vary per
    // attempt — retry promises re-execution, not identical bytes.
    const first = await sut.run(postReq(body, "p16-retry"));
    const second = await sut.run(postReq(body, "p16-retry"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(4);
    await flushAccounting();
    expect(sut.events).toHaveLength(2);
    expect(sut.events.map((e) => e.cost)).toEqual([2, 2]);
  });

  test("admitted batch isolates per-child failures, never whole-batch 502", async () => {
    const sut = makeSut(async (url: string) => {
      if (url.includes("/transcript")) {
        throw new Error("boom");
      }
      return { status: 200, body: { ok: true } };
    });
    const res = await sut.run(
      postReq({
        requests: [
          { method: "GET", path: "/api/v1/videos/abc/transcript" },
          { method: "POST", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/health" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const results = await res.json().then((b) => b.data.results);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe(502);
    expect(results[0].body.error.code).toBe("batch_upstream_failed");
    expect(results[1].status).toBe(400);
    expect(results[1].body.error.code).toBe("batch_method_not_allowed");
    expect(results[2].status).toBe(200);
    // Only runnable children execute and price: transcript(3) + health(1).
    expect(sut.executions()).toBe(2);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(4);
    // Failed children degrade the usage row to partial (telemetry history
    // only — the summed charge already landed), with the full child
    // summary; the internal signal never reaches the wire.
    expect(res.headers.get("x-tubelens-batch-partial")).toBeNull();
    await flushAccounting();
    expect(sut.events).toHaveLength(1);
    expect(sut.events[0]).toMatchObject({
      route: "batch",
      operation: "batch.execute",
      cost: 4,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "partial",
    });
    expect(sut.events[0]?.children).toHaveLength(2);
  });

  test("hung child degrades to per-item 504 under the shared deadline", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    let executions = 0;
    const run = createBatchHandler(
      {
        execute: async () => {
          executions += 1;
          return new Promise<never>(() => {});
        },
      },
      {
        auth: { resolve: async () => ({ ...anonymousAuthContext }) },
        env: {},
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      { overallMs: 25 },
    );
    const res = await run(
      postReq({ requests: [{ method: "GET", path: "/api/v1/health" }] }),
    );
    expect(res.status).toBe(200);
    const results = await res.json().then((b) => b.data.results);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(504);
    expect(results[0].body.error.code).toBe("batch_timeout");
    expect(executions).toBe(1);
  });

  test("allowlist frozen: binary/RSS/nested stay per-item 400s in an admitted 200", async () => {
    const sut = makeSut();
    const res = await sut.run(
      postReq({
        requests: [
          { method: "GET", path: "/api/v1/videos/abc/audio" },
          { method: "GET", path: "/api/v1/channels/UCx/rss" },
          { method: "GET", path: "/api/v1/batch" },
          { method: "GET", path: "/api/v1/health" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const results = await res.json().then((b) => b.data.results);
    const codes = results.map(
      (r: { body: { error?: { code?: string } } }) => r.body.error?.code,
    );
    expect(results.map((r: { status: number }) => r.status)).toEqual([
      400, 400, 400, 200,
    ]);
    expect(codes).toEqual([
      "batch_path_not_allowed",
      "batch_path_not_allowed",
      "batch_nested",
      undefined,
    ]);
    // Only the runnable health child executed and priced.
    expect(sut.executions()).toBe(1);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(1);
  });

  test("backslash paths reject as invalid (no normalization bypass)", async () => {
    // WHATWG URL parsing normalizes `\` to `/`: without this gate the child
    // below would price as videos.get (1) yet execute as the 4-credit
    // combined route.
    const sut = makeSut();
    const res = await sut.run(
      postReq({
        requests: [
          { method: "GET", path: "/api/v1/videos/abc\\combined" },
          { method: "GET", path: "/api/v1/health" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const results = await res.json().then((b) => b.data.results);
    expect(results[0].status).toBe(400);
    expect(results[0].body.error.code).toBe("batch_invalid_path");
    expect(results[1].status).toBe(200);
    // Only the health child executed and priced — the backslash child never
    // reached pricing or execution.
    expect(sut.executions()).toBe(1);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(1);
    await flushAccounting();
    expect(sut.events).toHaveLength(1);
    expect(sut.events[0]).toMatchObject({ cost: 1, outcome: "partial" });
  });
});

describe("phase 16 review fixes: zero-work bypass and per-item pricing", () => {
  test("all-static batch admits for throttling only: limiter weight 1, zero quota, cost-0 row", async () => {
    const sut = makeSut();
    const res = await sut.run(
      postReq({
        requests: [
          { method: "POST", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/batch" },
          { method: "GET", path: "/api/v1/nope" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const results = await res.json().then((b) => b.data.results);
    expect(
      results.map(
        (r: { body: { error: { code: string } } }) => r.body.error.code,
      ),
    ).toEqual([
      "batch_method_not_allowed",
      "batch_nested",
      "batch_path_not_allowed",
    ]);
    // Zero work executed, but the admission still throttles: exactly one
    // limiter weight at the floor.
    expect(sut.executions()).toBe(0);
    expect(sut.rateChecks).toHaveLength(1);
    expect(sut.rateChecks[0]).toMatchObject({
      endpointClass: "batch",
      cost: 1,
    });
    // Quota-exempt: the store total is untouched...
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(0);
    // ...and the single usage row honestly stamps the zero charge. Every
    // child failed, so the row is partial — same rule as runnable batches.
    await flushAccounting();
    expect(sut.events).toHaveLength(1);
    expect(sut.events[0]).toMatchObject({
      route: "batch",
      operation: "batch.execute",
      cost: 0,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "partial",
    });
    expect(sut.events[0]?.children).toEqual([]);
  });

  test("invalid X-Request-Id mints consistently across preflight and pipeline", async () => {
    const sut = makeSut();
    const res = await sut.run(
      postReq(
        { requests: [{ method: "GET", path: "/api/v1/health" }] },
        "!!! not valid !!!",
      ),
    );
    expect(res.status).toBe(200);
    const header = res.headers.get("X-Request-Id");
    expect(header).not.toBe("!!! not valid !!!");
    expect(header).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const body = await res.json();
    expect(body.meta.requestId).toBe(header);
    // Still an admitted runnable batch: the minted id carried through.
    expect(sut.executions()).toBe(1);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await sut.store.get("anonymous", windowId)).toBe(1);
  });

  test("unpriceable runnable demotes to per-item 400, remainder untouched", () => {
    const staticErr: BatchSubResult = {
      status: 400,
      body: { error: { code: "x", message: "m", hint: "h", status: 400 } },
    };
    const out = demoteUnpriceableBatchTasks([
      { kind: "run", url: "http://x/api/v1/nope", pathname: "/api/v1/nope" },
      {
        kind: "run",
        url: "http://x/api/v1/health",
        pathname: "/api/v1/health",
      },
      { kind: "static", result: staticErr },
    ]);
    expect(out).toHaveLength(3);
    const first: BatchTask | undefined = out[0];
    if (!first || first.kind !== "static") {
      throw new Error("expected the unpriceable child demoted to static");
    }
    expect(first.result.status).toBe(400);
    expect(first.result.body).toMatchObject({
      error: { code: "batch_path_not_allowed" },
    });
    expect(out[1]).toEqual({
      kind: "run",
      url: "http://x/api/v1/health",
      pathname: "/api/v1/health",
    });
    expect(out[2]).toEqual({ kind: "static", result: staticErr });
  });

  test("allowlist/pricing agreement: every allowlisted sample prices", () => {
    const samples = [
      "/api/v1/health",
      "/api/v1/openapi.json",
      "/api/v1/resolve",
      "/api/v1/search?q=lofi",
      "/api/v1/search/suggestions",
      "/api/v1/thumbnails",
      "/api/v1/instances",
      "/api/v1/quota",
      "/api/v1/videos/abc",
      "/api/v1/videos/abc/related",
      "/api/v1/videos/abc/comments",
      "/api/v1/videos/abc/captions",
      "/api/v1/videos/abc/transcript",
      "/api/v1/videos/abc/sponsors",
      "/api/v1/videos/abc/dislikes",
      "/api/v1/videos/abc/dearrow",
      "/api/v1/videos/abc/combined",
      "/api/v1/videos/abc/radio",
      "/api/v1/videos/abc/lyrics",
      "/api/v1/channels/UCx",
      "/api/v1/channels/UCx/videos",
      "/api/v1/channels/UCx/shorts",
      "/api/v1/channels/UCx/streams",
      "/api/v1/channels/UCx/playlists",
      "/api/v1/playlists/PLx",
      "/api/v1/playlists/PLx/items",
      "/api/v1/feed/shorts",
      "/api/v1/feed/live",
      "/api/v1/feed/gaming",
      "/api/v1/music/search",
      "/api/v1/music/charts",
      "/api/v1/hashtags/lofi",
      "/api/v1/artists/ax",
      "/api/v1/mixes/mx",
    ];
    for (const path of samples) {
      expect(() => resolveBatchChildRoute(path)).not.toThrow();
    }
    // Nested batch is unpriceable by construction (fail closed).
    expect(() => resolveBatchChildRoute("/api/v1/batch")).toThrow();
  });
});

const MARKER_TEST_SECRET = "phase16-test-secret-key";

function childRun(
  store: InMemoryQuotaStore,
  limiterChecks: RateLimitCheck[],
  events: UsageEvent[],
  env: Record<string, string | undefined>,
  route = "search",
): (req: NextRequest) => Promise<Response> {
  return withRequestContext(
    async (_r, ctx) =>
      successResponse({ ok: true }, { requestId: ctx.requestId }),
    {
      auth: { resolve: async () => ({ ...anonymousAuthContext }) },
      quotaStore: store,
      rateLimit: {
        check: (check: RateLimitCheck) => {
          limiterChecks.push(check);
          return {
            allowed: true,
            limit: 100,
            remaining: 99,
            reset: Math.floor(Date.now() / 1000) + 60,
          };
        },
      },
      usage: {
        record: (event: UsageEvent) => {
          events.push(event);
        },
      },
      env,
    },
    route,
  );
}

describe("phase 16 costOverride validation", () => {
  test("fractional costOverride fails closed with typed 500, limiter untouched", async () => {
    const limiter: RateLimitCheck[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        auth: { resolve: async () => ({ ...anonymousAuthContext }) },
        env: {},
        rateLimit: {
          check: (check: RateLimitCheck) => {
            limiter.push(check);
            return {
              allowed: true,
              limit: 100,
              remaining: 99,
              reset: Math.floor(Date.now() / 1000) + 60,
            };
          },
        },
      },
      "search",
      { costOverride: 1.5 },
    );
    const res = await run(new NextRequest("http://x/api/v1/search?q=a"));
    expect(res.status).toBe(500);
    expect(await res.json().then((b) => b.error.code)).toBe("internal");
    expect(limiter).toHaveLength(0);
  });
});

describe("phase 16 already-billed marker", () => {
  test("mint/verify round-trip, path+method binding, tamper resistance", () => {
    const marker = mintBatchChildMarker(
      MARKER_TEST_SECRET,
      "GET",
      "/api/v1/search?q=lofi",
    );
    expect(marker).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "GET",
        "/api/v1/search?q=lofi",
        marker,
      ),
    ).toBe(true);
    // Bound to the exact method + path: reuse elsewhere fails.
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "GET",
        "/api/v1/search?q=other",
        marker,
      ),
    ).toBe(false);
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "POST",
        "/api/v1/search?q=lofi",
        marker,
      ),
    ).toBe(false);
    expect(
      verifyBatchChildMarker(
        "wrong-secret",
        "GET",
        "/api/v1/search?q=lofi",
        marker,
      ),
    ).toBe(false);
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "GET",
        "/api/v1/search?q=lofi",
        "0".repeat(64),
      ),
    ).toBe(false);
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "GET",
        "/api/v1/search?q=lofi",
        "not-hex",
      ),
    ).toBe(false);
    expect(
      verifyBatchChildMarker("", "GET", "/api/v1/search?q=lofi", marker),
    ).toBe(false);
  });

  test("secret resolution: dedicated wins, clerk fallback, absent null", () => {
    expect(getBatchMarkerSecret({})).toBeNull();
    expect(getBatchMarkerSecret({ CLERK_SECRET_KEY: "  " })).toBeNull();
    expect(getBatchMarkerSecret({ CLERK_SECRET_KEY: "ck" })).toBe("ck");
    expect(
      getBatchMarkerSecret({
        TUBELENS_BATCH_HMAC_KEY: "ded",
        CLERK_SECRET_KEY: "ck",
      }),
    ).toBe("ded");
    // A blank dedicated key never shadows a valid fallback.
    expect(
      getBatchMarkerSecret({
        TUBELENS_BATCH_HMAC_KEY: "  ",
        CLERK_SECRET_KEY: "ck",
      }),
    ).toBe("ck");
  });

  test("verified child skips limiter/quota/usage; forged or keyless markers admit normally", async () => {
    const env = { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET };
    const pathQuery = "/api/v1/search?q=lofi";
    const valid = mintBatchChildMarker(MARKER_TEST_SECRET, "GET", pathQuery);

    // Verified: handler runs, nothing else moves.
    {
      const store = new InMemoryQuotaStore();
      const limiter: RateLimitCheck[] = [];
      const events: UsageEvent[] = [];
      const res = await childRun(
        store,
        limiter,
        events,
        env,
      )(
        new NextRequest(`http://x${pathQuery}`, {
          headers: { [BATCH_CHILD_HEADER]: valid },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).not.toBeNull();
      const { windowId } = quotaWindowFor(Date.now());
      expect(await store.get("anonymous", windowId)).toBe(0);
      expect(limiter).toHaveLength(0);
      await flushAccounting();
      expect(events).toHaveLength(0);
    }

    // Forged marker: ignored, normal admission (fail toward charging).
    {
      const store = new InMemoryQuotaStore();
      const limiter: RateLimitCheck[] = [];
      const events: UsageEvent[] = [];
      const res = await childRun(
        store,
        limiter,
        events,
        env,
      )(
        new NextRequest(`http://x${pathQuery}`, {
          headers: { [BATCH_CHILD_HEADER]: "f".repeat(64) },
        }),
      );
      expect(res.status).toBe(200);
      const { windowId } = quotaWindowFor(Date.now());
      expect(await store.get("anonymous", windowId)).toBe(1);
      expect(limiter).toHaveLength(1);
      expect(limiter[0]).toMatchObject({ endpointClass: "search", cost: 1 });
      await flushAccounting();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ cost: 1, outcome: "accepted" });
    }

    // Valid marker but no secret configured: not honored, normal admission.
    {
      const store = new InMemoryQuotaStore();
      const limiter: RateLimitCheck[] = [];
      const events: UsageEvent[] = [];
      const res = await childRun(
        store,
        limiter,
        events,
        {},
      )(
        new NextRequest(`http://x${pathQuery}`, {
          headers: { [BATCH_CHILD_HEADER]: valid },
        }),
      );
      expect(res.status).toBe(200);
      const { windowId } = quotaWindowFor(Date.now());
      expect(await store.get("anonymous", windowId)).toBe(1);
      expect(limiter).toHaveLength(1);
    }

    // Rotation window: a marker minted with the previous key still
    // verifies when the environment carries current + previous (a parent
    // admitted pre-redeploy stays honored when loopback lands its children
    // on a new instance).
    {
      const oldMarker = mintBatchChildMarker("old-secret", "GET", pathQuery);
      const store = new InMemoryQuotaStore();
      const limiter: RateLimitCheck[] = [];
      const events: UsageEvent[] = [];
      const res = await childRun(store, limiter, events, {
        TUBELENS_BATCH_HMAC_KEY: "new-secret",
        TUBELENS_BATCH_HMAC_PREVIOUS_KEY: "old-secret",
      })(
        new NextRequest(`http://x${pathQuery}`, {
          headers: { [BATCH_CHILD_HEADER]: oldMarker },
        }),
      );
      expect(res.status).toBe(200);
      const { windowId } = quotaWindowFor(Date.now());
      expect(await store.get("anonymous", windowId)).toBe(0);
      expect(limiter).toHaveLength(0);
      await flushAccounting();
      expect(events).toHaveLength(0);
    }
  });

  test("production path: parent summed charge + marked child adds nothing; unmarked child charges", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    const store = new InMemoryQuotaStore();
    const parentLimiter: RateLimitCheck[] = [];
    const parentEvents: UsageEvent[] = [];
    const run = createBatchHandler(
      {
        execute: async () => ({ status: 200, body: { ok: true } }),
      },
      {
        auth: { resolve: async () => ({ ...anonymousAuthContext }) },
        env: { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET },
        quotaStore: store,
        rateLimit: {
          check: (check: RateLimitCheck) => {
            parentLimiter.push(check);
            return {
              allowed: true,
              limit: 100,
              remaining: 99,
              reset: Math.floor(Date.now() / 1000) + 60,
            };
          },
        },
        usage: {
          record: (event: UsageEvent) => {
            parentEvents.push(event);
          },
        },
      },
    );
    // Parent carries caller credentials: they must reach the child extras.
    const res = await run(
      postReq(
        { requests: [{ method: "GET", path: "/api/v1/health" }] },
        "p16-int",
        false,
        { authorization: "Bearer sess_test", cookie: "sess=abc" },
      ),
    );
    expect(res.status).toBe(200);
    const { windowId } = quotaWindowFor(Date.now());
    // Single summed charge for the whole batch (health = 1).
    expect(await store.get("anonymous", windowId)).toBe(1);
    expect(parentLimiter).toHaveLength(1);
    expect(parentLimiter[0]).toMatchObject({ endpointClass: "batch", cost: 1 });

    // Re-drive one child through the REAL pipeline with the exact headers
    // the parent minted (models the loopback re-entry): verified → free.
    const childLimiter: RateLimitCheck[] = [];
    const childEvents: UsageEvent[] = [];
    const driveChild = childRun(
      store,
      childLimiter,
      childEvents,
      {
        TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET,
      },
      "health",
    );
    // Rebuild the extras the parent would have sent (credentials + marker)
    // by re-running the batch with a capturing executor.
    let captured: Record<string, string> = {};
    const capturing = createBatchHandler(
      {
        execute: async (_u, _r, _s, extra) => {
          captured = { ...(extra ?? {}) };
          return { status: 200, body: { ok: true } };
        },
      },
      {
        auth: { resolve: async () => ({ ...anonymousAuthContext }) },
        env: { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET },
        quotaStore: store,
        rateLimit: {
          check: () => ({
            allowed: true,
            limit: 100,
            remaining: 99,
            reset: Math.floor(Date.now() / 1000) + 60,
          }),
        },
        usage: { record: () => {} },
      },
    );
    await capturing(
      postReq(
        { requests: [{ method: "GET", path: "/api/v1/health" }] },
        "p16-int2",
        false,
        { authorization: "Bearer sess_test", cookie: "sess=abc" },
      ),
    );
    expect(captured.authorization).toBe("Bearer sess_test");
    expect(captured.cookie).toBe("sess=abc");
    expect(captured[BATCH_CHILD_HEADER]).toMatch(/^[0-9a-f]{64}$/);

    const marked = await driveChild(
      new NextRequest("http://x/api/v1/health", {
        headers: {
          [BATCH_CHILD_HEADER]: captured[BATCH_CHILD_HEADER] as string,
        },
      }),
    );
    expect(marked.status).toBe(200);
    expect(await store.get("anonymous", windowId)).toBe(2);
    expect(childLimiter).toHaveLength(0);
    await flushAccounting();
    expect(childEvents).toHaveLength(0);

    // Same child without the marker is a normal admission: charged.
    const plain = await driveChild(new NextRequest("http://x/api/v1/health"));
    expect(plain.status).toBe(200);
    expect(await store.get("anonymous", windowId)).toBe(3);
    expect(childLimiter).toHaveLength(1);
  });

  test("signer honors the injected pipeline env, not just process.env", async () => {
    delete process.env.TUBELENS_BATCH_HMAC_KEY;
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    let captured: Record<string, string> = {};
    const run = createBatchHandler(
      {
        execute: async (_u, _r, _s, extra) => {
          captured = { ...(extra ?? {}) };
          return { status: 200, body: { ok: true } };
        },
      },
      {
        auth: { resolve: async () => ({ ...anonymousAuthContext }) },
        quotaStore: new InMemoryQuotaStore(),
        env: { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET },
      },
    );
    const res = await run(
      postReq({ requests: [{ method: "GET", path: "/api/v1/health" }] }),
    );
    expect(res.status).toBe(200);
    // Mint and verify must agree on the environment: a providers.env-only
    // secret still signs children the pipeline (same env) accepts.
    expect(
      verifyBatchChildMarker(
        MARKER_TEST_SECRET,
        "GET",
        "/api/v1/health",
        captured[BATCH_CHILD_HEADER] as string,
      ),
    ).toBe(true);
  });

  test("forwarded credentials resolve the caller principal in the child", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    const TOKEN = "Bearer user_42_token";
    // Test double for Clerk: this bearer maps to user_42, anything else
    // resolves anonymous.
    const mappingAuth = {
      resolve: async (req: Request) =>
        req.headers.get("authorization") === TOKEN
          ? {
              ...anonymousAuthContext,
              type: "user" as const,
              authenticated: true,
              userId: "user_42",
            }
          : { ...anonymousAuthContext },
    };
    const store = new InMemoryQuotaStore();
    let captured: Record<string, string> = {};
    const run = createBatchHandler(
      {
        execute: async (_u, _r, _s, extra) => {
          captured = { ...(extra ?? {}) };
          return { status: 200, body: { ok: true } };
        },
      },
      {
        auth: mappingAuth,
        env: { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET },
        quotaStore: store,
      },
    );
    const res = await run(
      postReq(
        { requests: [{ method: "GET", path: "/api/v1/health" }] },
        "p16-authed",
        false,
        { authorization: TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    expect(captured.authorization).toBe(TOKEN);
    const { windowId } = quotaWindowFor(Date.now());
    // Parent charged the caller's bucket, not the shared anonymous one.
    expect(await store.get("user:user_42", windowId)).toBe(1);
    expect(await store.get("anonymous", windowId)).toBe(0);

    // Re-drive a child through the real pipeline with exactly the captured
    // headers: the forwarded credential must resolve the same principal,
    // so the charge lands on the caller's bucket (a forwarding break would
    // misattribute it to anonymous instead).
    const driveChild = withRequestContext(
      async (_r, ctx) =>
        successResponse(
          { userId: ctx.auth.userId ?? null },
          { requestId: ctx.requestId },
        ),
      {
        auth: mappingAuth,
        quotaStore: store,
        env: { TUBELENS_BATCH_HMAC_KEY: MARKER_TEST_SECRET },
      },
      "search",
    );
    const authed = await driveChild(
      new NextRequest("http://x/api/v1/search?q=lofi", {
        headers: { authorization: captured.authorization as string },
      }),
    );
    expect(authed.status).toBe(200);
    expect(await authed.json().then((b) => b.data.userId)).toBe("user_42");
    expect(await store.get("user:user_42", windowId)).toBe(2);
    expect(await store.get("anonymous", windowId)).toBe(0);
  });

  test("defaultBatchDeps forwards credentials + marker over the pinned sub-fetch", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const out = await defaultBatchDeps.execute(
        "http://127.0.0.1:3000/api/v1/health",
        "rid-fwd",
        undefined,
        {
          authorization: "Bearer sess_test",
          cookie: "sess=abc",
          [BATCH_CHILD_HEADER]: "m".repeat(64),
        },
      );
      expect(out).toEqual({ status: 200, body: { ok: true } });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:3000/api/v1/health");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sess_test");
    expect(seen[0]?.headers.get("cookie")).toBe("sess=abc");
    expect(seen[0]?.headers.get("x-request-id")).toBe("rid-fwd");
    expect(seen[0]?.headers.get(BATCH_CHILD_HEADER)).toBe("m".repeat(64));
  });
});
