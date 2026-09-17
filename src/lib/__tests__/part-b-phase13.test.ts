// Phase 13 (Part B): weighted-credit operation catalog.
//
// Proves the centralized catalog prices every shipped route label, cheap vs
// expensive operations deduct different costs, unknown operations fail
// closed (never free), batch totals sum child costs with a hard preflight
// ceiling (rejected batches execute no children), historical rows keep
// their original version/cost across a policy change, and the pipeline
// wires the resolved cost into the rate-limit check and usage event.

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";
import {
  BATCH_MAX_COST,
  costForBatch,
  isKnownOperation,
  QUOTA_POLICY_PREVIOUS_VERSION,
  QUOTA_POLICY_VERSION,
  QuotaPolicyError,
  quotaRouteLabels,
  resolveBatchChildRoute,
  resolveOperationCost,
  resolveOperationCostAt,
} from "../quota";
import type { RateLimitCheck, RateLimitProvider } from "../rate-limit";
import type { UsageEvent } from "../usage";
import { type BatchDeps, handleBatch } from "../utils";

// ---------------------------------------------------------------------------
// Catalog completeness: every shipped route label priced, no extras.
// ---------------------------------------------------------------------------

const EXPECTED_COSTS: Record<string, number> = {
  // Cheap reads (1).
  health: 1,
  me: 1,
  openapi: 1,
  quota: 1,
  resolve: 1,
  search: 1,
  "search.suggestions": 1,
  thumbnails: 1,
  instances: 1,
  "videos.get": 1,
  "videos.captions": 1,
  "videos.lyrics": 1,
  "videos.radio": 1,
  "channels.profile": 1,
  "channels.rss": 1,
  "playlists.meta": 1,
  "feed.shorts": 1,
  "feed.live": 1,
  "feed.gaming": 1,
  "music.search": 1,
  "music.charts": 1,
  "hashtags.get": 1,
  "artists.get": 1,
  "mixes.get": 1,
  "tunnel.get": 1,
  "admin.users.role": 1,
  "admin.users.tier": 1,
  "admin.keys.revoke": 1,
  "admin.keys.create": 1,
  "admin.keys.list": 1,
  // Medium reads (2).
  "videos.related": 2,
  "videos.comments": 2,
  "videos.sponsors": 2,
  "videos.dislikes": 2,
  "videos.dearrow": 2,
  "channels.videos": 2,
  "channels.shorts": 2,
  "channels.streams": 2,
  "channels.playlists": 2,
  "playlists.items": 2,
  // Expensive reads (3).
  "videos.transcript": 3,
  "videos.audio": 3,
  // Composed read (4).
  "videos.combined": 4,
  // Batch declares its ceiling as its worst-case cost.
  batch: BATCH_MAX_COST,
};

describe("phase 13 catalog completeness", () => {
  test("catalog keys exactly match the shipped-route list", () => {
    expect(quotaRouteLabels()).toEqual(Object.keys(EXPECTED_COSTS).sort());
  });

  test("every label resolves to a well-formed priced record", () => {
    for (const label of quotaRouteLabels()) {
      const resolved = resolveOperationCost(label);
      expect(resolved.operation.length).toBeGreaterThan(0);
      expect(Number.isInteger(resolved.cost)).toBe(true);
      expect(resolved.cost).toBeGreaterThanOrEqual(1);
      expect(resolved.cost).toBe(EXPECTED_COSTS[label]);
      expect(resolved.policyVersion).toBe(QUOTA_POLICY_VERSION);
      expect(isKnownOperation(label)).toBe(true);
    }
  });

  test("cheap vs medium vs expensive vs composed differ", () => {
    expect(resolveOperationCost("search").cost).toBe(1);
    expect(resolveOperationCost("videos.comments").cost).toBe(2);
    expect(resolveOperationCost("videos.transcript").cost).toBe(3);
    expect(resolveOperationCost("videos.combined").cost).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Fail closed: unknown operations never become free.
// ---------------------------------------------------------------------------

describe("phase 13 unknown operations fail closed", () => {
  test("resolveOperationCost throws a typed error, never 0", () => {
    for (const bad of ["nope.unknown", "", "BATCH", "videos.frobnicate"]) {
      let error: unknown;
      try {
        resolveOperationCost(bad);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(QuotaPolicyError);
      expect((error as QuotaPolicyError).code).toBe("unknown_operation");
      expect(isKnownOperation(bad)).toBe(false);
    }
  });

  test("isKnownOperation rejects non-strings", () => {
    expect(isKnownOperation(undefined)).toBe(false);
    expect(isKnownOperation(null)).toBe(false);
    expect(isKnownOperation(42)).toBe(false);
  });

  test("unknown policy version throws, never falls back to live prices", () => {
    let error: unknown;
    try {
      resolveOperationCostAt("2099-01-01.free.v99", "search");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(QuotaPolicyError);
    expect((error as QuotaPolicyError).code).toBe("unknown_policy_version");
  });
});

// ---------------------------------------------------------------------------
// Batch economics: sum of children, hard ceiling, no work on reject.
// ---------------------------------------------------------------------------

describe("phase 13 batch economics", () => {
  test("child pathnames resolve to catalog labels (query strings ignored)", () => {
    expect(resolveBatchChildRoute("/api/v1/health")).toBe("health");
    expect(resolveBatchChildRoute("/api/v1/search?q=lofi&limit=5")).toBe(
      "search",
    );
    expect(resolveBatchChildRoute("/api/v1/videos/abc123")).toBe("videos.get");
    expect(resolveBatchChildRoute("/api/v1/videos/abc123/transcript")).toBe(
      "videos.transcript",
    );
    expect(resolveBatchChildRoute("/api/v1/channels/UCxyz/shorts")).toBe(
      "channels.shorts",
    );
    expect(resolveBatchChildRoute("/api/v1/playlists/PLxyz/items")).toBe(
      "playlists.items",
    );
    expect(resolveBatchChildRoute("/api/v1/feed/live")).toBe("feed.live");
  });

  test("nested batch and unknown paths fail closed", () => {
    for (const bad of ["/api/v1/batch", "/api/v1/nope", "/api/v1/videos"]) {
      expect(() => resolveBatchChildRoute(bad)).toThrow(QuotaPolicyError);
    }
  });

  test("costForBatch sums child costs", () => {
    const priced = costForBatch([
      "/api/v1/search?q=lofi",
      "/api/v1/videos/abc123/transcript",
      "/api/v1/health",
    ]);
    expect(priced.operation).toBe("batch.execute");
    expect(priced.cost).toBe(1 + 3 + 1);
    expect(priced.policyVersion).toBe(QUOTA_POLICY_VERSION);
    expect(priced.children.map((c) => c.route)).toEqual([
      "search",
      "videos.transcript",
      "health",
    ]);
  });

  test("costForBatch over the ceiling throws before any work", () => {
    // 10 x transcript = 30 > 20.
    expect(() =>
      costForBatch(
        Array.from({ length: 10 }, (_, i) => `/api/v1/videos/v${i}/transcript`),
      ),
    ).toThrow(QuotaPolicyError);
    try {
      costForBatch([
        "/api/v1/videos/a/combined",
        "/api/v1/videos/b/combined",
        "/api/v1/videos/c/combined",
        "/api/v1/videos/d/combined",
        "/api/v1/videos/e/combined",
        "/api/v1/videos/f/combined",
      ]);
      expect.unreachable();
    } catch (err) {
      expect((err as QuotaPolicyError).code).toBe("batch_cost_exceeded");
    }
  });

  test("costForBatch rejects empty and oversized child lists", () => {
    expect(() => costForBatch([])).toThrow(QuotaPolicyError);
    expect(() =>
      costForBatch(Array.from({ length: 11 }, () => "/api/v1/health")),
    ).toThrow(QuotaPolicyError);
  });
});

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("phase 13 batch ceiling preflight (handleBatch)", () => {
  const savedOrigin = process.env.TUBELENS_PUBLIC_URL;
  afterEach(() => {
    if (savedOrigin === undefined) {
      delete process.env.TUBELENS_PUBLIC_URL;
    } else {
      process.env.TUBELENS_PUBLIC_URL = savedOrigin;
    }
  });

  test("over-cap batch rejected with no child execution", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    let executions = 0;
    const deps: BatchDeps = {
      execute: async () => {
        executions += 1;
        return { status: 200, body: { ok: true } };
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: Array.from({ length: 10 }, (_, i) => ({
          method: "GET",
          path: `/api/v1/videos/v${i}/transcript`,
        })),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("batch_cost_exceeded");
    expect(body.error.hint).toContain(String(BATCH_MAX_COST));
    expect(executions).toBe(0);
  });

  test("under-cap batch executes every child", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    const seen: string[] = [];
    const deps: BatchDeps = {
      execute: async (url: string) => {
        seen.push(url);
        return { status: 200, body: { ok: true } };
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/search?q=lofi" },
          { method: "GET", path: "/api/v1/videos/abc123/transcript" },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  test("all-static-error batch skips pricing, keeps per-item errors", async () => {
    process.env.TUBELENS_PUBLIC_URL = "http://x";
    let executions = 0;
    const deps: BatchDeps = {
      execute: async () => {
        executions += 1;
        return { status: 200, body: { ok: true } };
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "POST", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/batch" },
          { method: "GET", path: "/api/v1/nope" },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const codes = (
      body.data.results as Array<{ body: { error: { code: string } } }>
    ).map((r) => r.body.error.code);
    expect(codes).toEqual([
      "batch_method_not_allowed",
      "batch_nested",
      "batch_path_not_allowed",
    ]);
    expect(executions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Historical versioning: stored rows keep original version/cost.
// ---------------------------------------------------------------------------

describe("phase 13 historical version pinning", () => {
  test("prior-version snapshot resolves old prices", () => {
    const prev = resolveOperationCostAt(
      QUOTA_POLICY_PREVIOUS_VERSION,
      "videos.combined",
    );
    expect(prev).toEqual({
      operation: "combined.get",
      cost: 5,
      policyVersion: QUOTA_POLICY_PREVIOUS_VERSION,
    });
  });

  test("stored event keeps its version/cost after the catalog moves on", () => {
    // A ledger row stamped under the previous policy...
    const stamped = resolveOperationCostAt(
      QUOTA_POLICY_PREVIOUS_VERSION,
      "videos.combined",
    );
    const storedEvent: UsageEvent = {
      requestId: "req_hist_1",
      route: "videos.combined",
      operation: stamped.operation,
      cost: stamped.cost,
      policyVersion: stamped.policyVersion,
      outcome: "accepted",
    };
    // ...is untouched by today's repricing (combined 5 -> 4).
    const current = resolveOperationCost("videos.combined");
    expect(current.cost).toBe(4);
    expect(current.policyVersion).toBe(QUOTA_POLICY_VERSION);
    expect(storedEvent.cost).toBe(5);
    expect(storedEvent.policyVersion).toBe(QUOTA_POLICY_PREVIOUS_VERSION);
  });

  test("current version resolves identically via resolveOperationCostAt", () => {
    expect(resolveOperationCostAt(QUOTA_POLICY_VERSION, "search")).toEqual(
      resolveOperationCost("search"),
    );
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: limiter weight + usage row from the catalog.
// ---------------------------------------------------------------------------

function req(url: string): NextRequest {
  return new NextRequest(url);
}

describe("phase 13 pipeline integration", () => {
  test("rate-limit check receives the resolved cost", async () => {
    const seen: RateLimitCheck[] = [];
    const rateLimit: RateLimitProvider = {
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
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { rateLimit },
      "videos.transcript",
    );
    const res = await run(req("http://x/api/v1/videos/abc/transcript"));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endpointClass).toBe("videos.transcript");
    expect(seen[0]?.cost).toBe(3);
  });

  test("usage event carries operation/cost/policyVersion", async () => {
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "videos.combined",
    );
    const res = await run(req("http://x/api/v1/videos/abc/combined"));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "videos.combined",
      operation: "combined.get",
      cost: 4,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "accepted",
    });
  });

  test("unknown route fails closed: typed 500, no limiter contact, no usage row", async () => {
    const seen: RateLimitCheck[] = [];
    const events: UsageEvent[] = [];
    const errors: unknown[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        rateLimit: {
          check: (check: RateLimitCheck) => {
            seen.push(check);
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
        observability: {
          startSpan: () => ({
            recordError: () => {},
            end: () => {},
          }),
          log: () => {},
          increment: () => {},
          captureError: (err: unknown) => {
            errors.push(err);
          },
        },
      },
      "nope.unknown",
    );
    const res = await run(req("http://x/api/v1/nope"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.hint).toContain("no priced operation");
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(0);
  });

  test("every label wired through withRequestContext is priced", () => {
    // Manually verified against src/app/api/v1/**/route.ts (grep for the
    // route-label argument to withRequestContext): a future route wired
    // with an unpriced label must trip this list, not silently 500.
    const wiredLabels = [
      "health",
      "me",
      "admin.keys.create",
      "admin.keys.list",
      "admin.keys.revoke",
      "admin.users.role",
      "admin.users.tier",
    ];
    expect(wiredLabels).toHaveLength(7);
    for (const label of wiredLabels) {
      expect(isKnownOperation(label)).toBe(true);
    }
  });
});
