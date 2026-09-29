// Phase 14 (Part B): quota accounting and monthly allowance.
//
// Proves the monthly UTC-calendar allowance: a fresh identity starts at
// 10,000 credits, consumes exact weighted costs, is rejected (without
// consuming, handler never runs) at zero, rolls into a full new window
// across a month boundary, survives restarts only via the durable ledger
// path, records partial batch outcomes, and fails closed on unknown
// operations. `GET /api/v1/quota` reports the same balance shape.

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest, type NextResponse } from "next/server";
import { GET as quotaRouteGET } from "../../app/api/v1/quota/route";
import { anonymousAuthContext } from "../auth";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";
import { QUOTA_POLICY_VERSION, QuotaPolicyError } from "../quota";
import {
  allowanceForTier,
  checkAllowance,
  checkAndConsume,
  getBalance,
  getQuotaStore,
  InMemoryQuotaStore,
  quotaPrincipal,
  quotaWindowFor,
  recordConsumption,
  resetQuotaStore,
  TIER_ALLOWANCES,
} from "../quota-accounting";
import {
  PostgresQuotaStore,
  recordUsageEvent,
  type UsageLedgerRow,
  type UsageLedgerWriter,
} from "../quota-ledger";
import { containsLikelySecret } from "../redact";
import type { UsageEvent } from "../usage";
import { handleQuota, handleQuotaContext } from "../utils";

// Fixed clocks: mid-September 2026 and just past the October boundary.
const SEP_NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const OCT_NOW = Date.UTC(2026, 9, 1, 0, 0, 1);

function req(url: string): NextRequest {
  return new NextRequest(url);
}

/** Stub writer double: rows in an array, sums computed locally.
 * Faithful to the real ledger on the two mechanical guarantees that
 * matter: balances sum ONLY `accepted` rows, and `billing_key` is UNIQUE —
 * a duplicate server-minted key is a no-op (ON CONFLICT DO NOTHING), never
 * a second row. The tracing `request_id` is deliberately NOT deduped:
 * distinct attempts may share one client-echoed id and must still charge.
 */
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

function acceptedRow(
  principal: string,
  windowId: string,
  cost: number,
  outcome: UsageLedgerRow["outcome"] = "accepted",
): UsageLedgerRow {
  seedCounter += 1;
  return {
    principal,
    tier: "free",
    operation: "search.query",
    cost,
    policyVersion: QUOTA_POLICY_VERSION,
    windowId,
    outcome,
    requestId: `req_seed_${seedCounter}`,
    billingKey: `bk_seed_${seedCounter}`,
  };
}

afterEach(() => {
  resetQuotaStore();
});

// ---------------------------------------------------------------------------
// Windows + allowances: pure calendar math, one deterministic Free number.
// ---------------------------------------------------------------------------

describe("phase 14 windows and allowances", () => {
  test("windowId is the UTC calendar month; resetMs is the next boundary", () => {
    expect(quotaWindowFor(SEP_NOW)).toEqual({
      windowId: "2026-09",
      resetMs: Date.UTC(2026, 9, 1),
    });
    expect(quotaWindowFor(OCT_NOW)).toEqual({
      windowId: "2026-10",
      resetMs: Date.UTC(2026, 10, 1),
    });
    // December rolls the year, January starts a fresh year window.
    expect(quotaWindowFor(Date.UTC(2026, 11, 31, 23, 59, 59)).windowId).toBe(
      "2026-12",
    );
    expect(quotaWindowFor(Date.UTC(2027, 0, 1)).windowId).toBe("2027-01");
  });

  test("free allowance is 10,000; reserved tiers fall back (placeholder)", () => {
    expect(TIER_ALLOWANCES.free).toBe(10_000);
    expect(allowanceForTier("free")).toBe(10_000);
    // plus/pro/enterprise have no defined numbers in PLANS_AND_USAGE.md §8:
    // conservative free fallback, never invented.
    for (const tier of ["plus", "pro", "enterprise"] as const) {
      expect(allowanceForTier(tier)).toBe(10_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine: exact consumption, exhaustion, month rollover.
// ---------------------------------------------------------------------------

describe("phase 14 consume and exhaust", () => {
  test("10k start, consume 1+2+3, exact remaining", async () => {
    const store = new InMemoryQuotaStore();
    const first = await checkAndConsume(store, {
      identity: "user:u1",
      tier: "free",
      cost: 1,
      operation: "search.query",
      nowMs: SEP_NOW,
    });
    expect(first.allowed).toBe(true);
    expect(first.used).toBe(1);
    expect(first.remaining).toBe(9_999);
    expect(first.windowId).toBe("2026-09");
    expect(first.policyVersion).toBe(QUOTA_POLICY_VERSION);

    await checkAndConsume(store, {
      identity: "user:u1",
      tier: "free",
      cost: 2,
      operation: "comments.list",
      nowMs: SEP_NOW,
    });
    const third = await checkAndConsume(store, {
      identity: "user:u1",
      tier: "free",
      cost: 3,
      operation: "transcript.get",
      nowMs: SEP_NOW,
    });
    expect(third.used).toBe(6);
    expect(third.remaining).toBe(9_994);

    const balance = await getBalance(store, "user:u1", "free", SEP_NOW);
    expect(balance).toMatchObject({
      allowance: 10_000,
      used: 6,
      remaining: 9_994,
      windowId: "2026-09",
      tier: "free",
      policyVersion: QUOTA_POLICY_VERSION,
    });
  });

  test("identities are isolated per window", async () => {
    const store = new InMemoryQuotaStore();
    await checkAndConsume(store, {
      identity: "user:a",
      tier: "free",
      cost: 5,
      operation: "search.query",
      nowMs: SEP_NOW,
    });
    expect((await getBalance(store, "user:b", "free", SEP_NOW)).used).toBe(0);
    expect((await getBalance(store, "user:a", "free", OCT_NOW)).used).toBe(0);
  });

  test("driven to 0, the next charge is rejected and consumes nothing", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(SEP_NOW);
    await store.add("user:full", windowId, 10_000);
    const denied = await checkAndConsume(store, {
      identity: "user:full",
      tier: "free",
      cost: 1,
      operation: "search.query",
      nowMs: SEP_NOW,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(10_000);
    expect(denied.remaining).toBe(0);
    expect(await store.get("user:full", windowId)).toBe(10_000);
  });

  test("clock across the month boundary opens a fresh full window", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId: sep } = quotaWindowFor(SEP_NOW);
    await store.add("user:u2", sep, 9_999);
    expect(
      (await getBalance(store, "user:u2", "free", SEP_NOW)).remaining,
    ).toBe(1);
    const oct = await checkAndConsume(store, {
      identity: "user:u2",
      tier: "free",
      cost: 3,
      operation: "transcript.get",
      nowMs: OCT_NOW,
    });
    expect(oct.allowed).toBe(true);
    expect(oct.windowId).toBe("2026-10");
    expect(oct.used).toBe(3);
    expect(oct.remaining).toBe(9_997);
    // September's total is untouched — history is per-window.
    expect(await store.get("user:u2", sep)).toBe(9_999);
  });

  test("corrupt store balances and bad inputs fail closed", async () => {
    const store = new InMemoryQuotaStore();
    await expect(
      checkAndConsume(store, {
        identity: "",
        tier: "free",
        cost: 1,
        operation: "search.query",
        nowMs: SEP_NOW,
      }),
    ).rejects.toThrow();
    await expect(
      checkAndConsume(store, {
        identity: "user:x",
        tier: "free",
        cost: 0,
        operation: "search.query",
        nowMs: SEP_NOW,
      }),
    ).rejects.toThrow();
    const poison = {
      get: () => Number.NaN,
      add: () => 0,
    };
    await expect(
      checkAndConsume(poison, {
        identity: "user:x",
        tier: "free",
        cost: 1,
        operation: "search.query",
        nowMs: SEP_NOW,
      }),
    ).rejects.toThrow("invalid balance");
  });
});

// ---------------------------------------------------------------------------
// Durability: memory is lost on restart; the ledger path rehydrates.
// ---------------------------------------------------------------------------

describe("phase 14 durability", () => {
  test("fresh in-memory store loses balances (restart loses accounting)", async () => {
    const before = new InMemoryQuotaStore();
    await checkAndConsume(before, {
      identity: "user:u3",
      tier: "free",
      cost: 42,
      operation: "search.query",
      nowMs: SEP_NOW,
    });
    // A restart is a fresh store: nothing rehydrates by default.
    const after = new InMemoryQuotaStore();
    expect((await getBalance(after, "user:u3", "free", SEP_NOW)).used).toBe(0);
  });

  test("stub-Postgres rehydrate: balance durable when the ledger path is on", async () => {
    const { windowId } = quotaWindowFor(SEP_NOW);
    const { writer, rows } = stubWriter([
      acceptedRow("user:kept", windowId, 100),
      acceptedRow("user:kept", windowId, 23),
      // Rejected rows are history, never consumption.
      { ...acceptedRow("user:kept", windowId, 7), outcome: "rejected" },
    ]);
    const durable = new PostgresQuotaStore(writer);
    const balance = await getBalance(durable, "user:kept", "free", SEP_NOW);
    expect(balance.used).toBe(123);
    expect(balance.remaining).toBe(10_000 - 123);

    const decided = await checkAndConsume(durable, {
      identity: "user:kept",
      tier: "free",
      cost: 2,
      operation: "comments.list",
      requestId: "req_charge_1",
      nowMs: SEP_NOW,
    });
    expect(decided.allowed).toBe(true);
    expect(decided.used).toBe(125);
    const inserted = rows[rows.length - 1];
    expect(inserted).toMatchObject({
      principal: "user:kept",
      tier: "free",
      operation: "comments.list",
      cost: 2,
      policyVersion: QUOTA_POLICY_VERSION,
      windowId,
      outcome: "accepted",
      requestId: "req_charge_1",
    });
  });

  test("partial batch outcome recorded with child-cost summary", async () => {
    const { writer, rows } = stubWriter();
    const partial: UsageEvent = {
      requestId: "req_batch_1",
      route: "batch",
      operation: "batch.execute",
      cost: 5,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "partial",
      principal: "user:batch",
      tier: "free",
      windowId: "2026-09",
      children: [
        { route: "search", operation: "search.query", cost: 1 },
        { route: "videos.transcript", operation: "transcript.get", cost: 3 },
        { route: "health", operation: "health.check", cost: 1 },
      ],
    };
    await recordUsageEvent(writer, partial);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal: "user:batch",
      operation: "batch.execute",
      cost: 5,
      policyVersion: QUOTA_POLICY_VERSION,
      windowId: "2026-09",
      outcome: "partial",
      requestId: "req_batch_1",
    });
    // Partial rows never feed balances.
    const durable = new PostgresQuotaStore(writer);
    expect(
      (await getBalance(durable, "user:batch", "free", SEP_NOW)).used,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: quota stage between rate-limit and handler.
// ---------------------------------------------------------------------------

describe("phase 14 pipeline quota stage", () => {
  test("success consumes and the accepted event carries window fields", async () => {
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
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
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "search",
      operation: "search.query",
      cost: 1,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "accepted",
      tier: "free",
      allowance: 10_000,
    });
    expect(typeof events[0]?.windowId).toBe("string");
    expect(typeof events[0]?.resetMs).toBe("number");
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(1);
  });

  test("exhausted quota rejects 429 quota_exceeded; handler never runs", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(Date.now());
    await store.add("anonymous", windowId, 10_000);
    const events: UsageEvent[] = [];
    let executions = 0;
    const run = withRequestContext(
      async (_r, ctx) => {
        executions += 1;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
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
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.status).toBe(429);
    expect(body.error.hint).toContain("Monthly credit allowance exhausted");
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-Request-Id")).toBe(body.meta.requestId);
    expect(executions).toBe(0);
    // Rejection consumed nothing.
    expect(await store.get("anonymous", windowId)).toBe(10_000);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: "videos.transcript",
      operation: "transcript.get",
      cost: 3,
      outcome: "rejected",
      tier: "free",
      allowance: 10_000,
    });
  });

  test("replayed client request ids still charge every attempt", async () => {
    // resolveRequestId echoes a valid caller X-Request-Id for tracing, so
    // ctx.requestId is client-controlled — charging must NOT dedupe on it.
    // Two distinct executions replaying one id charge twice (evasion closed).
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(Date.now());
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { quotaStore: store },
      "search",
    );
    const replay = () =>
      run(
        new NextRequest("http://x/api/v1/search?q=lofi", {
          headers: { "x-request-id": "replayed-client-id" },
        }),
      );
    const first = await replay();
    const second = await replay();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both responses echo the replayed tracing id...
    expect(first.headers.get("X-Request-Id")).toBe("replayed-client-id");
    expect(second.headers.get("X-Request-Id")).toBe("replayed-client-id");
    // ...but the server-minted billing keys differ, so both charged.
    expect(await store.get("anonymous", windowId)).toBe(2);
  });

  test("unknown operation fails closed: typed 500, quota untouched", async () => {
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "nope.unknown",
    );
    const res = await run(req("http://x/api/v1/nope"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(0);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(0);
  });

  test("broken quota store fails closed with typed 503", async () => {
    const broken: {
      get: () => Promise<number>;
      add: () => Promise<number>;
    } = {
      get: () => Promise.reject(new Error("ledger down")),
      add: () => Promise.reject(new Error("ledger down")),
    };
    let executions = 0;
    const run = withRequestContext(
      async (_r, ctx) => {
        executions += 1;
        return successResponse({ ok: true }, { requestId: ctx.requestId });
      },
      { quotaStore: broken },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("service_unavailable");
    expect(executions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/quota: monthly balance shape.
// ---------------------------------------------------------------------------

describe("phase 14 quota endpoint", () => {
  test("reports allowance/used/remaining/reset/windowId/tier/policyVersion", async () => {
    const store = new InMemoryQuotaStore();
    const res = await handleQuota(req("http://x/api/v1/quota"), {
      store,
      identity: "user:status",
      nowMs: SEP_NOW,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({
      allowance: 10_000,
      used: 0,
      remaining: 10_000,
      reset: Math.floor(Date.UTC(2026, 9, 1) / 1000),
      windowId: "2026-09",
      tier: "free",
      policyVersion: QUOTA_POLICY_VERSION,
    });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    // A balance check never consumes.
    expect(await store.get("user:status", "2026-09")).toBe(0);
  });

  test("reflects consumed credits for the identity", async () => {
    const store = new InMemoryQuotaStore();
    await checkAndConsume(store, {
      identity: "user:spent",
      tier: "free",
      cost: 4,
      operation: "combined.get",
      nowMs: SEP_NOW,
    });
    const res = await handleQuota(req("http://x/api/v1/quota"), {
      store,
      identity: "user:spent",
      nowMs: SEP_NOW,
    });
    const body = await res.json();
    expect(body.data.used).toBe(4);
    expect(body.data.remaining).toBe(9_996);
  });

  test("default store resolves without env (in-memory)", async () => {
    delete process.env.TUBELENS_QUOTA_DURABLE;
    const store = await getQuotaStore();
    expect(store).toBeInstanceOf(InMemoryQuotaStore);
  });

  test("opted-in but unbuildable durable store fails loudly, never silent memory", async () => {
    const savedFlag = process.env.TUBELENS_QUOTA_DURABLE;
    const savedUrl = process.env.DATABASE_URL;
    try {
      process.env.TUBELENS_QUOTA_DURABLE = "1";
      process.env.DATABASE_URL = "postgresql://bogus";
      resetQuotaStore();
      // Under bun the server-only DB chain cannot even load; in production
      // the equivalent failure (bad URL, unreachable Neon) rejects here too.
      // Either way: loud rejection → pipeline 503, never quiet in-memory.
      await expect(getQuotaStore()).rejects.toThrow();
    } finally {
      if (savedFlag === undefined) {
        delete process.env.TUBELENS_QUOTA_DURABLE;
      } else {
        process.env.TUBELENS_QUOTA_DURABLE = savedFlag;
      }
      if (savedUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = savedUrl;
      }
      resetQuotaStore();
    }
  });

  test("opted-in durable without DATABASE_URL throws config error", async () => {
    const savedFlag = process.env.TUBELENS_QUOTA_DURABLE;
    const savedUrl = process.env.DATABASE_URL;
    try {
      process.env.TUBELENS_QUOTA_DURABLE = "1";
      delete process.env.DATABASE_URL;
      resetQuotaStore();
      // Half-configured durability must fail loudly (→ pipeline 503), not
      // fall back to memory and silently lose accounting.
      await expect(getQuotaStore()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (savedFlag === undefined) {
        delete process.env.TUBELENS_QUOTA_DURABLE;
      } else {
        process.env.TUBELENS_QUOTA_DURABLE = savedFlag;
      }
      if (savedUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = savedUrl;
      }
      resetQuotaStore();
    }
  });
});

// ---------------------------------------------------------------------------
// Review: attempt-based charging — throws never charge, attempts do.
// ---------------------------------------------------------------------------

describe("phase 14 attempt-based charging", () => {
  test("handler error response still charges the attempt", async () => {
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse(
          { error: "upstream" },
          { requestId: ctx.requestId, status: 502 },
        ),
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
    expect(res.status).toBe(502);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "rejected", cost: 1 });
  });

  test("handler throw charges nothing (our crash, no response)", async () => {
    const store = new InMemoryQuotaStore();
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (): Promise<never> => {
        throw new Error("boom");
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
    expect(res.status).toBe(500);
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(0);
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Review: single-writer + idempotent ledger — no double-charge, one principal.
// ---------------------------------------------------------------------------

describe("phase 14 double-charge guard", () => {
  test("same billing key twice = one row, one charge (retry-safe)", async () => {
    const { writer, rows } = stubWriter();
    const durable = new PostgresQuotaStore(writer);
    const { windowId } = quotaWindowFor(SEP_NOW);
    const event = {
      requestId: "req_idem_1",
      route: "search",
      operation: "search.query",
      cost: 2,
      policyVersion: QUOTA_POLICY_VERSION,
      outcome: "accepted" as const,
      principal: "user:idem",
      tier: "free",
      windowId,
    };
    await recordUsageEvent(writer, event, "bk_idem_1");
    // A retried record of the SAME attempt (same billing key) hits ON
    // CONFLICT DO NOTHING — mechanically incapable of double-charge.
    await recordUsageEvent(writer, event, "bk_idem_1");
    expect(rows).toHaveLength(1);
    expect(await durable.get("user:idem", windowId)).toBe(2);
  });

  test("same request id, distinct billing keys = distinct charges", async () => {
    const { writer, rows } = stubWriter();
    // Distinct attempts may share one client-echoed X-Request-Id (the
    // pipeline echoes valid caller ids for tracing) — every attempt must
    // still charge. Dedup NEVER keys on the tracing id.
    await recordUsageEvent(
      writer,
      {
        requestId: "req_replayed",
        route: "search",
        operation: "search.query",
        cost: 1,
        policyVersion: QUOTA_POLICY_VERSION,
        outcome: "accepted",
        principal: "user:replay",
        tier: "free",
        windowId: "2026-09",
      },
      "bk_replay_1",
    );
    await recordUsageEvent(
      writer,
      {
        requestId: "req_replayed",
        route: "search",
        operation: "search.query",
        cost: 1,
        policyVersion: QUOTA_POLICY_VERSION,
        outcome: "accepted",
        principal: "user:replay",
        tier: "free",
        windowId: "2026-09",
      },
      "bk_replay_2",
    );
    expect(rows).toHaveLength(2);
    const durable = new PostgresQuotaStore(writer);
    expect(await durable.get("user:replay", "2026-09")).toBe(2);
  });

  test("quotaPrincipal is one choke point for store key and ledger row", () => {
    expect(
      quotaPrincipal({
        auth: {
          type: "user",
          authenticated: true,
          userId: "user_abc",
        },
        rateLimitIdentity: "user:user_abc",
      }),
    ).toBe("user:user_abc");
    expect(
      quotaPrincipal({
        auth: anonymousAuthContext,
        rateLimitIdentity: "anonymous",
      }),
    ).toBe("anonymous");
  });

  test("anonymous callers share one bucket (no per-IP minting)", async () => {
    const store = new InMemoryQuotaStore();
    const run = (q: string) =>
      withRequestContext(
        async (_r, ctx) =>
          successResponse({ ok: true }, { requestId: ctx.requestId }),
        { quotaStore: store },
        "search",
      )(req(`http://x/api/v1/search?q=${q}`));
    await run("a");
    await run("b");
    const { windowId } = quotaWindowFor(Date.now());
    expect(await store.get("anonymous", windowId)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Review: 503 shape, tier continuity, overshoot bound, secret hygiene.
// ---------------------------------------------------------------------------

describe("phase 14 review hardening", () => {
  test("store failure 503 carries request-id + rate-limit headers, no Retry-After", async () => {
    const broken = {
      get: () => Promise.reject(new Error("ledger down")),
      add: () => Promise.reject(new Error("ledger down")),
    };
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { quotaStore: broken },
      "search",
    );
    const res = await run(req("http://x/api/v1/search?q=lofi"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("X-RateLimit-Limit")).not.toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).not.toBeNull();
    expect(res.headers.get("X-RateLimit-Reset")).not.toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    // 503 is a dependency outage, not a rate signal: no Retry-After hint.
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("tier change mid-window keeps one bucket, allowance per tier rules", async () => {
    const store = new InMemoryQuotaStore();
    await checkAndConsume(store, {
      identity: "user:tiered",
      tier: "free",
      cost: 100,
      operation: "search.query",
      requestId: "req_tier_1",
      nowMs: SEP_NOW,
    });
    // Tiers share the identity bucket (no per-tier partitions); only the
    // allowance number is per-tier — currently the identical free
    // placeholder for every tier until PLANS_AND_USAGE.md defines them.
    const pro = await getBalance(store, "user:tiered", "pro", SEP_NOW);
    expect(pro.used).toBe(100);
    expect(pro.allowance).toBe(allowanceForTier("pro"));
    expect(pro.remaining).toBe(allowanceForTier("pro") - 100);
  });

  test("peek-then-consume can overshoot under concurrency (best-effort)", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(SEP_NOW);
    await store.add("user:race", windowId, 9_999);
    // Three attempts peek the same 9_999 — all admitted — then all consume.
    const checks = await Promise.all(
      ["req_race_0", "req_race_1", "req_race_2"].map((requestId) =>
        checkAllowance(store, {
          identity: "user:race",
          tier: "free",
          cost: 1,
          nowMs: SEP_NOW,
        }).then((check) => ({ check, requestId })),
      ),
    );
    expect(checks.every(({ check }) => check.allowed)).toBe(true);
    for (const { check, requestId } of checks) {
      await recordConsumption(store, {
        identity: "user:race",
        tier: "free",
        windowId: check.windowId,
        cost: 1,
        operation: "search.query",
        policyVersion: QUOTA_POLICY_VERSION,
        requestId,
      });
    }
    // Overshoot is pinned, not prevented: atomic cross-instance enforcement
    // is the Redis limiter's job (Phase 15) — Postgres is the durable
    // record, not the race gate, and the in-memory default is per-process.
    expect(await store.get("user:race", windowId)).toBe(10_002);
  });

  test("ledger rows and usage events carry no secret shapes", async () => {
    const { writer, rows } = stubWriter();
    const durable = new PostgresQuotaStore(writer);
    await checkAndConsume(durable, {
      identity: "user:clean",
      tier: "free",
      cost: 1,
      operation: "search.query",
      requestId: "req_clean_1",
      nowMs: SEP_NOW,
    });
    const events: UsageEvent[] = [];
    const run = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      {
        quotaStore: new InMemoryQuotaStore(),
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "search",
    );
    await run(req("http://x/api/v1/search?q=lofi"));
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    for (const blob of [
      ...rows.map((row) => JSON.stringify(row)),
      ...events.map((event) => JSON.stringify(event)),
    ]) {
      expect(containsLikelySecret(blob)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Review: GET /quota reports the CALLER's identity/window via the pipeline.
// ---------------------------------------------------------------------------

describe("phase 14 quota route identity", () => {
  test("handleQuotaContext reports the authed principal bucket", async () => {
    const store = new InMemoryQuotaStore();
    await checkAndConsume(store, {
      identity: "user:user_9",
      tier: "free",
      cost: 7,
      operation: "search.query",
      requestId: "req_ctx_1",
      nowMs: SEP_NOW,
    });
    const res = await handleQuotaContext({
      requestId: "r1",
      auth: {
        type: "user",
        authenticated: true,
        userId: "user_9",
      },
      tier: "free",
      rateLimitIdentity: "user:user_9",
      store,
      nowMs: SEP_NOW,
    });
    expect(res.status).toBe(200);
    expect(await res.json().then((b) => b.data)).toMatchObject({
      used: 7,
      remaining: 9_993,
      windowId: "2026-09",
      tier: "free",
    });
  });

  test("GET /quota serves the caller balance through the pipeline", async () => {
    // Keyless env: clerkAuthProvider resolves anonymous, so this exercises
    // the anonymous bucket end to end (shape only — the shared default
    // store accumulates across the suite).
    const res = await quotaRouteGET(req("http://x/api/v1/quota"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data.allowance).toBe(10_000);
    expect(body.data.windowId).toBe(quotaWindowFor(Date.now()).windowId);
    expect(body.data.tier).toBe("free");
    expect(body.data.policyVersion).toBe(QUOTA_POLICY_VERSION);
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
  });
});

// ---------------------------------------------------------------------------
// Review round 2: free balance reads, retry-safe stores, minted ledger keys.
// ---------------------------------------------------------------------------

describe("phase 14 free balance reads", () => {
  function quotaRun(
    store: InMemoryQuotaStore,
    events: UsageEvent[],
  ): (req: NextRequest) => Promise<NextResponse> {
    return withRequestContext(
      async (r, ctx) =>
        handleQuotaContext({
          requestId: ctx.requestId,
          auth: ctx.auth,
          tier: ctx.tier,
          rateLimitIdentity: ctx.rateLimitIdentity,
          origin: r.headers.get("origin"),
          store,
        }),
      {
        quotaStore: store,
        usage: {
          record: (event: UsageEvent) => {
            events.push(event);
          },
        },
      },
      "quota",
    );
  }

  test("quota-labeled requests skip peek and consume, report live fields", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(Date.now());
    const searchRun = withRequestContext(
      async (_r, ctx) =>
        successResponse({ ok: true }, { requestId: ctx.requestId }),
      { quotaStore: store },
      "search",
    );
    await searchRun(req("http://x/api/v1/search?q=a"));
    await searchRun(req("http://x/api/v1/search?q=b"));
    expect(await store.get("anonymous", windowId)).toBe(2);

    const events: UsageEvent[] = [];
    const res = await quotaRun(store, events)(req("http://x/api/v1/quota"));
    expect(res.status).toBe(200);
    // Untouched by the balance read...
    expect(await store.get("anonymous", windowId)).toBe(2);
    expect(await res.json().then((b) => b.data)).toMatchObject({
      allowance: 10_000,
      used: 2,
      remaining: 9_998,
      windowId,
      tier: "free",
      policyVersion: QUOTA_POLICY_VERSION,
    });

    // ...and readable at exhaustion: an empty bucket still serves 200.
    await store.add("anonymous", windowId, 9_998);
    const exhausted = await quotaRun(
      store,
      events,
    )(req("http://x/api/v1/quota"));
    expect(exhausted.status).toBe(200);
    expect(await exhausted.json().then((b) => b.data.used)).toBe(10_000);
    expect(await store.get("anonymous", windowId)).toBe(10_000);
  });

  test("quota status: store failures are 503, programmer errors are 500", async () => {
    const input = {
      requestId: "req_quota_ctx",
      auth: anonymousAuthContext,
      tier: "free" as const,
      rateLimitIdentity: "anonymous",
    };
    const failing = {
      get: () => Promise.reject(new Error("ledger down")),
      add: () => Promise.reject(new Error("ledger down")),
    };
    const down = await handleQuotaContext({ ...input, store: failing });
    expect(down.status).toBe(503);
    expect(await down.json().then((b) => b.error.code)).toBe(
      "service_unavailable",
    );
    const buggy = {
      get: () => Promise.reject(new TypeError("cannot read property")),
      add: () => Promise.reject(new TypeError("cannot read property")),
    };
    const broken = await handleQuotaContext({ ...input, store: buggy });
    expect(broken.status).toBe(500);
    expect(await broken.json().then((b) => b.error.code)).toBe("internal");
  });
});

describe("phase 14 retry-safe stores", () => {
  test("in-memory retries with the same billing key charge once", async () => {
    const store = new InMemoryQuotaStore();
    const details = {
      operation: "search.query",
      policyVersion: QUOTA_POLICY_VERSION,
      tier: "free",
      // Tracing id replays across attempts — charging must NOT key on it.
      requestId: "req_replayed_1",
      billingKey: "bk_retry_1",
    };
    expect(await store.add("user:retry", "2026-09", 3, details)).toBe(3);
    expect(await store.add("user:retry", "2026-09", 3, details)).toBe(3);
    // Same tracing id, distinct billing key = distinct attempt = charge.
    expect(
      await store.add("user:retry", "2026-09", 3, {
        ...details,
        billingKey: "bk_retry_2",
      }),
    ).toBe(6);
    // ...and keyless adds always charge (nothing to dedupe on).
    expect(await store.add("user:retry", "2026-09", 3)).toBe(9);
  });

  test("postgres retries charge once; id-less adds mint distinct keys", async () => {
    const { writer, rows } = stubWriter();
    const durable = new PostgresQuotaStore(writer);
    const details = {
      operation: "search.query",
      policyVersion: QUOTA_POLICY_VERSION,
      tier: "free",
      requestId: "req_pg_replayed_1",
      billingKey: "bk_pg_retry_1",
    };
    expect(await durable.add("user:pgr", "2026-09", 2, details)).toBe(2);
    expect(await durable.add("user:pgr", "2026-09", 2, details)).toBe(2);
    expect(rows).toHaveLength(1);
    // Key-less adds mint distinct billing keys — both charge, never "".
    await durable.add("user:pgr", "2026-09", 2);
    await durable.add("user:pgr", "2026-09", 2);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.billingKey !== "")).toBe(true);
    expect(new Set(rows.map((r) => r.billingKey)).size).toBe(3);
    expect(await durable.get("user:pgr", "2026-09")).toBe(6);
  });

  test("recordConsumption with one billing key twice charges once", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId } = quotaWindowFor(SEP_NOW);
    const input = {
      identity: "user:engine",
      tier: "free" as const,
      windowId,
      cost: 2,
      operation: "search.query",
      policyVersion: QUOTA_POLICY_VERSION,
      requestId: "req_engine_replayed",
      billingKey: "bk_engine_1",
    };
    expect((await recordConsumption(store, input)).used).toBe(2);
    expect((await recordConsumption(store, input)).used).toBe(2);
    expect(await store.get("user:engine", windowId)).toBe(2);
  });

  test("in-memory billing-key dedup is scoped per window (no cross-month leak)", async () => {
    const store = new InMemoryQuotaStore();
    const { windowId: sep } = quotaWindowFor(SEP_NOW);
    const { windowId: oct } = quotaWindowFor(OCT_NOW);
    const details = (billingKey: string) => ({
      operation: "search.query",
      policyVersion: QUOTA_POLICY_VERSION,
      tier: "free",
      requestId: "req_roll",
      billingKey,
    });
    expect(await store.add("user:roll", sep, 3, details("bk_roll_1"))).toBe(3);
    // Same-window retry dedupes.
    expect(await store.add("user:roll", sep, 3, details("bk_roll_1"))).toBe(3);
    // Rolling the month evicts prior-window keys: the same billing key in
    // September charges again (bounded memory — keys never leak across
    // windows), while per-window balances are untouched.
    expect(await store.add("user:roll", oct, 3, details("bk_roll_2"))).toBe(3);
    expect(await store.add("user:roll", sep, 3, details("bk_roll_1"))).toBe(6);
    expect(await store.get("user:roll", sep)).toBe(6);
    expect(await store.get("user:roll", oct)).toBe(3);
  });

  test("postgres add rejects unknown/negative costs pre-insert (typed, no row)", async () => {
    const { writer, rows } = stubWriter();
    const durable = new PostgresQuotaStore(writer);
    const details = {
      operation: "search.query",
      policyVersion: QUOTA_POLICY_VERSION,
      tier: "free",
      requestId: "req_bad_cost",
      billingKey: "bk_bad_cost",
    };
    await expect(
      durable.add("user:bad", "2026-09", -1, details),
    ).rejects.toBeInstanceOf(QuotaPolicyError);
    await expect(
      durable.add("user:bad", "2026-09", -1, details),
    ).rejects.toMatchObject({ code: "invalid_quota_cost" });
    await expect(
      durable.add("user:bad", "2026-09", Number.NaN, details),
    ).rejects.toMatchObject({ code: "invalid_quota_cost" });
    await expect(
      durable.add("user:bad", "2026-09", 1.5, details),
    ).rejects.toMatchObject({ code: "invalid_quota_cost" });
    expect(rows).toHaveLength(0);
  });
});
