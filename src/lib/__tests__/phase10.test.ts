import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { clearCache } from "../cache";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import {
  type BatchDeps,
  buildChannelRss,
  type ChannelRssDeps,
  escapeXml,
  getInstances,
  getQuotaSnapshot,
  handleBatch,
  handleChannelRss,
  handleInstances,
  handleMix,
  handleQuota,
  handleThumbnails,
  parseMixSeed,
  parsePeerInstances,
  parseThumbnailParams,
  RSS_MAX_ITEMS,
  resetQuotaForTests,
  resolveBatchOrigin,
  thumbnailUrls,
} from "../utils";

const UC = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const VID = "dQw4w9WgXcQ";

function req(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", "phase10");
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body,
    headers,
  });
}

function jsonReq(url: string, body: unknown): NextRequest {
  return req(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function rssDeps(overrides?: Partial<ChannelRssDeps>): ChannelRssDeps {
  return {
    resolveChannelId: async (input: string) =>
      input.startsWith("UC") ? input : UC,
    fetchChannel: async (): Promise<{
      profile: unknown;
      firstPage: ContinuationSearch;
    }> => ({
      profile: {
        header: { author: { name: "Test Channel" } },
        metadata: {},
      },
      firstPage: {
        results: [
          { type: "Video", video_id: "vid000000001", title: "First & best" },
          { type: "Video", video_id: "vid000000002", title: "Second <cut>" },
        ],
        has_continuation: false,
        getContinuation: async () => {
          throw new Error("exhausted");
        },
      },
    }),
    ...overrides,
  };
}

const savedPeers = process.env.TUBELENS_PEER_INSTANCES;
const savedVercelUrl = process.env.VERCEL_URL;

function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}

beforeEach(() => {
  clearCache();
  clearContinuations();
  resetQuotaForTests();
  restoreEnv("TUBELENS_PEER_INSTANCES", savedPeers);
  restoreEnv("VERCEL_URL", savedVercelUrl);
  // Batch fan-out pins to a trusted origin (never the request Host): always
  // force the http://x test origin so fake executors see stable URLs — even
  // when the suite itself runs with TUBELENS_PUBLIC_URL exported.
  process.env.TUBELENS_PUBLIC_URL = "http://x";
});

// ---------------------------------------------------------------------------
// RSS: raw feed, XML escaping, typed errors
// ---------------------------------------------------------------------------

describe("phase 10 channel rss", () => {
  test("serves raw rss+xml with escaped titles + watch urls", async () => {
    const res = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      rssDeps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(res.headers.get("X-Request-Id")).toBe("phase10");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
    const xml = await res.text();
    expect(xml).toContain("<rss version=");
    expect(xml).toContain("<title>Test Channel</title>");
    expect(xml).toContain("First &amp; best");
    expect(xml).toContain("Second &lt;cut&gt;");
    expect(xml).toContain("https://www.youtube.com/watch?v=vid000000001");
    expect(xml).not.toContain("{");
  });

  test("invalid channel id -> 400 typed error", async () => {
    const res = await handleChannelRss(req("http://x/rss"), "nope", rssDeps());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_channel_id");
    expect(typeof body.error.hint).toBe("string");
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  test("upstream timeout -> 504 typed hint, never bare 500", async () => {
    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const res = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      rssDeps({
        fetchChannel: async () => {
          throw err;
        },
      }),
    );
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_timeout");
    expect(typeof body.error.hint).toBe("string");
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  test("unknown channel -> 404 channel_not_found", async () => {
    const res = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      rssDeps({
        fetchChannel: async () => {
          throw new Error(`channel_not_found: ${UC}`);
        },
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("channel_not_found");
  });

  test("single upstream fetch serves title + tab (no 2x getChannel)", async () => {
    let calls = 0;
    const deps = rssDeps({
      fetchChannel: async (...args) => {
        calls += 1;
        const base = rssDeps();
        return base.fetchChannel(...args);
      },
    });
    const first = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      deps,
    );
    expect(first.status).toBe(200);
    const second = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      deps,
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.text());
    expect(calls).toBe(1);
  });

  test("escapeXml covers the five entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  test("rssChannelTitle reads Text-object/runs names, not just strings", async () => {
    const deps = rssDeps({
      fetchChannel: async () => ({
        profile: {
          header: {
            author: { name: { runs: [{ text: "Obj " }, { text: "Title" }] } },
          },
          metadata: {},
        },
        firstPage: {
          results: [],
          has_continuation: false,
          getContinuation: async () => {
            throw new Error("exhausted");
          },
        },
      }),
    });
    const res = await handleChannelRss(
      req(`http://x/api/v1/channels/${UC}/rss`),
      UC,
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Obj Title</title>");
  });

  test("buildChannelRss caps items and escapes channel text", () => {
    const items = Array.from({ length: RSS_MAX_ITEMS + 5 }, (_, i) => ({
      id: `vid${i}`,
      title: `T${i}`,
    }));
    const xml = buildChannelRss(UC, "A&B", items);
    expect(xml.match(/<item>/g)).toHaveLength(RSS_MAX_ITEMS);
    expect(xml).toContain("<title>A&amp;B</title>");
    expect(xml).toContain(`https://www.youtube.com/channel/${UC}`);
  });
});

// ---------------------------------------------------------------------------
// Mixes: seed -> RD mix lookup
// ---------------------------------------------------------------------------

describe("phase 10 mixes", () => {
  test("video seed maps to RD mix id with envelope + playlist TTL", async () => {
    const res = await handleMix(req("http://x/api/v1/mixes/x"), VID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ mixId: `RD${VID}`, seedId: VID });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain(
      "mix_items_via_playlist",
    );
  });

  test("RD mix id passes through with remainder seed", async () => {
    const res = await handleMix(req("http://x/api/v1/mixes/x"), `RD${VID}`);
    expect((await res.json()).data).toEqual({
      mixId: `RD${VID}`,
      seedId: VID,
    });
  });

  test("garbage -> 400 invalid_mix_id with playlists hint", async () => {
    const res = await handleMix(req("http://x/api/v1/mixes/x"), "!!!");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_mix_id");
    expect(body.error.hint).toContain("/api/v1/playlists/");
  });

  test("parseMixSeed rejects bare RD", () => {
    expect(parseMixSeed("RD").ok).toBe(false);
  });

  test("parseMixSeed boundaries: 4-char seeds invalid, 5-char valid", () => {
    expect(parseMixSeed("abcd").ok).toBe(false);
    expect(parseMixSeed("abcde")).toEqual({
      ok: true,
      value: { mixId: "RDabcde", seedId: "abcde" },
    });
    expect(parseMixSeed("RDa")).toEqual({
      ok: true,
      value: { mixId: "RDa", seedId: "a" },
    });
  });
});

// ---------------------------------------------------------------------------
// Thumbnails: pure resolver
// ---------------------------------------------------------------------------

describe("phase 10 thumbnails", () => {
  test("default quality is medium with best pointer", async () => {
    const res = await handleThumbnails(
      req(`http://x/api/v1/thumbnails?videoId=${VID}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.videoId).toBe(VID);
    expect(body.data.quality).toBe("medium");
    expect(body.data.best).toContain("/mqdefault.jpg");
    expect(body.data.urls.default).toContain("/default.jpg");
    expect(body.data.urls.high).toContain("/hqdefault.jpg");
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
  });

  test("quality=high selects hqdefault", async () => {
    const res = await handleThumbnails(
      req(`http://x/api/v1/thumbnails?videoId=${VID}&quality=high`),
    );
    expect((await res.json()).data.best).toContain("/hqdefault.jpg");
  });

  test("missing videoId -> 400 invalid_video_id", async () => {
    const res = await handleThumbnails(req("http://x/api/v1/thumbnails"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
  });

  test("bad quality -> 400 invalid_quality", async () => {
    const res = await handleThumbnails(
      req(`http://x/api/v1/thumbnails?videoId=${VID}&quality=4k`),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_quality");
  });

  test("thumbnailUrls uses public i.ytimg.com patterns only", () => {
    const urls = thumbnailUrls(VID);
    for (const u of Object.values(urls)) {
      expect(u.startsWith(`https://i.ytimg.com/vi/${VID}/`)).toBe(true);
    }
    expect(parseThumbnailParams(new URLSearchParams()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Instances: static list
// ---------------------------------------------------------------------------

describe("phase 10 instances", () => {
  test("single self entry when no peers configured", async () => {
    delete process.env.TUBELENS_PEER_INSTANCES;
    const res = await handleInstances(req("http://localhost/api/v1/instances"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.instances).toEqual([
      { url: "http://localhost", self: true, status: "ready" },
    ]);
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=60");
  });

  test("peers appended, garbage dropped", async () => {
    process.env.TUBELENS_PEER_INSTANCES =
      "https://b.example, garbage, https://a.example/, https://b.example";
    const res = await handleInstances(req("http://localhost/api/v1/instances"));
    const body = await res.json();
    expect(body.data.instances).toEqual([
      { url: "http://localhost", self: true, status: "ready" },
      { url: "https://b.example", self: false, status: "unknown" },
      { url: "https://a.example", self: false, status: "unknown" },
    ]);
  });

  test("parsePeerInstances caps and getInstances dedupes self", () => {
    expect(parsePeerInstances(undefined)).toEqual([]);
    expect(
      getInstances("https://a.example", ["https://a.example"]),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Batch: validation + per-item isolation
// ---------------------------------------------------------------------------

const fakeBatchDeps: BatchDeps = {
  execute: async (url: string) => {
    if (url.includes("fail")) {
      throw new Error("boom");
    }
    return { status: 200, body: { ok: true, url } };
  },
};

describe("phase 10 batch", () => {
  test("mixed items isolate errors, whole batch stays 200", async () => {
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: "/api/v1/health" },
          { method: "POST", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/batch" },
          { method: "GET", path: "/api/v1/nope" },
          { method: "GET", path: "/api/v1/search?q=lofi&limit=1" },
          { method: "GET", path: "/api/v1/videos/fail12345" },
        ],
      }),
      fakeBatchDeps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    const [ok, method, nested, unknownPath, search, failed] = body.data
      .results as Array<{ status: number; body: unknown }>;
    expect(ok.status).toBe(200);
    expect(method.status).toBe(400);
    expect((method.body as { error: { code: string } }).error.code).toBe(
      "batch_method_not_allowed",
    );
    expect((nested.body as { error: { code: string } }).error.code).toBe(
      "batch_nested",
    );
    expect((unknownPath.body as { error: { code: string } }).error.code).toBe(
      "batch_path_not_allowed",
    );
    expect(search.status).toBe(200);
    expect(failed.status).toBe(502);
    expect((failed.body as { error: { code: string } }).error.code).toBe(
      "batch_upstream_failed",
    );
  });

  test("more than 10 requests -> 400 invalid_batch", async () => {
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: Array.from({ length: 11 }, () => ({
          method: "GET",
          path: "/api/v1/health",
        })),
      }),
      fakeBatchDeps,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_batch");
    expect(body.error.hint).toContain("10");
  });

  test("non-JSON body and empty array -> 400 invalid_batch", async () => {
    const garbage = await handleBatch(
      req("http://x/api/v1/batch", { method: "POST", body: "nope{" }),
      fakeBatchDeps,
    );
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error.code).toBe("invalid_batch");
    const empty = await handleBatch(
      jsonReq("http://x/api/v1/batch", { requests: [] }),
      fakeBatchDeps,
    );
    expect(empty.status).toBe(400);
  });

  test("sub-requests run concurrently (order-preserving)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const concurrent: BatchDeps = {
      execute: async (url: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { status: 200, body: { url } };
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/quota" },
          { method: "GET", path: "/api/v1/instances" },
        ],
      }),
      concurrent,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.data.results.map((r: { body: { url: string } }) => r.body.url),
    ).toEqual([
      "http://x/api/v1/health",
      "http://x/api/v1/quota",
      "http://x/api/v1/instances",
    ]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("hung sub-request hits the shared deadline, batch still 200", async () => {
    const hanging: BatchDeps = {
      execute: () => new Promise(() => {}),
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [{ method: "GET", path: "/api/v1/health" }],
      }),
      hanging,
      { overallMs: 50 },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0].status).toBe(504);
    expect(body.data.results[0].body.error.code).toBe("batch_timeout");
  });

  test("timed-out items get fresh bodies, never a shared alias", async () => {
    const hanging: BatchDeps = {
      execute: () => new Promise(() => {}),
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: "/api/v1/health" },
          { method: "GET", path: "/api/v1/quota" },
        ],
      }),
      hanging,
      { overallMs: 50 },
    );
    const body = await res.json();
    const [a, b] = body.data.results as Array<{
      status: number;
      body: unknown;
    }>;
    expect(a.status).toBe(504);
    expect(b.status).toBe(504);
    expect(a.body).not.toBe(b.body);
  });

  test("shared deadline aborts losing sub-fetches", async () => {
    let seen: AbortSignal | undefined;
    const abortable: BatchDeps = {
      execute: (url: string, _requestId: string, signal?: AbortSignal) => {
        seen = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new Error(`aborted ${url}`)),
          );
        });
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [{ method: "GET", path: "/api/v1/health" }],
      }),
      abortable,
      { overallMs: 50 },
    );
    const body = await res.json();
    expect(body.data.results[0].status).toBe(504);
    expect(body.data.results[0].body.error.code).toBe("batch_timeout");
    expect(seen?.aborted).toBe(true);
  });

  test("binary routes (audio bytes, rss feed) are not batchable", async () => {
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: `/api/v1/videos/${VID}/audio` },
          { method: "GET", path: `/api/v1/channels/${UC}/rss` },
        ],
      }),
      fakeBatchDeps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const item of body.data.results as Array<{
      status: number;
      body: { error: { code: string } };
    }>) {
      expect(item.status).toBe(400);
      expect(item.body.error.code).toBe("batch_path_not_allowed");
    }
  });

  test("per-item fail-fast timeout classifies as 504, generic errors as 502", async () => {
    const flaky: BatchDeps = {
      execute: async (url: string) => {
        if (url.includes("timeout")) {
          const err = new Error("Upstream timed out after 8000ms");
          err.name = "TimeoutError";
          throw err;
        }
        throw new Error("boom");
      },
    };
    const res = await handleBatch(
      jsonReq("http://x/api/v1/batch", {
        requests: [
          { method: "GET", path: "/api/v1/videos/timeout12345" },
          { method: "GET", path: "/api/v1/videos/fail12345" },
        ],
      }),
      flaky,
    );
    const body = await res.json();
    const [timedOut, failed] = body.data.results as Array<{
      status: number;
      body: { error: { code: string } };
    }>;
    expect(timedOut.status).toBe(504);
    expect(timedOut.body.error.code).toBe("batch_timeout");
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("batch_upstream_failed");
  });
});

describe("phase 10 batch trusted origin (SSRF pinning)", () => {
  async function withBatchEnv(
    vars: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      prev[key] = process.env[key];
    }
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fn();
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  test("explicit TUBELENS_PUBLIC_URL wins and is origin-normalized", async () => {
    await withBatchEnv(
      {
        TUBELENS_PUBLIC_URL: "https://api.example.com/base?x=1",
        VERCEL_URL: "x.vercel.app",
      },
      async () => {
        expect(
          resolveBatchOrigin(req("https://evil.example/api/v1/batch")),
        ).toBe("https://api.example.com");
      },
    );
  });

  test("invalid explicit URL falls through to VERCEL_URL", async () => {
    await withBatchEnv(
      {
        TUBELENS_PUBLIC_URL: "ftp://nope",
        VERCEL_URL: "my-app-abc123.vercel.app",
      },
      async () => {
        expect(
          resolveBatchOrigin(req("https://evil.example/api/v1/batch")),
        ).toBe("https://my-app-abc123.vercel.app");
      },
    );
  });

  test("malicious VERCEL_URL is rejected; loopback dev still works", async () => {
    await withBatchEnv(
      { TUBELENS_PUBLIC_URL: undefined, VERCEL_URL: "evil.example/pwn" },
      async () => {
        expect(
          resolveBatchOrigin(req("https://evil.example/api/v1/batch")),
        ).toBeNull();
        expect(
          resolveBatchOrigin(req("http://localhost:3000/api/v1/batch")),
        ).toBe("http://localhost:3000");
      },
    );
  });

  test("production ignores the loopback fallback and fails closed", async () => {
    await withBatchEnv(
      {
        TUBELENS_PUBLIC_URL: undefined,
        VERCEL_URL: undefined,
        NODE_ENV: "production",
      },
      async () => {
        // Attacker-chosen loopback port must not become a fan-out target.
        expect(
          resolveBatchOrigin(req("http://127.0.0.1:9999/api/v1/batch")),
        ).toBeNull();
        const seen: string[] = [];
        const res = await handleBatch(
          jsonReq("http://127.0.0.1:9999/api/v1/batch", {
            requests: [{ method: "GET", path: "/api/v1/health" }],
          }),
          {
            execute: async (url: string) => {
              seen.push(url);
              return { status: 200, body: {} };
            },
          },
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe("batch_not_configured");
        expect(seen).toEqual([]);
      },
    );
  });

  test("untrusted origin fails closed with 503, never the raw Host", async () => {
    await withBatchEnv(
      { TUBELENS_PUBLIC_URL: undefined, VERCEL_URL: undefined },
      async () => {
        const seen: string[] = [];
        const res = await handleBatch(
          jsonReq("https://evil.example/api/v1/batch", {
            requests: [{ method: "GET", path: "/api/v1/health" }],
          }),
          {
            execute: async (url: string) => {
              seen.push(url);
              return { status: 200, body: {} };
            },
          },
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe("batch_not_configured");
        expect(seen).toEqual([]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Quota: stub counters
// ---------------------------------------------------------------------------

describe("phase 10 quota", () => {
  test("reports limit/remaining/reset + windows, private no-store", async () => {
    const first = await handleQuota(req("http://x/api/v1/quota"));
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const a = await first.json();
    expect(a.data.limit).toBe(100);
    expect(a.data.remaining).toBe(99);
    expect(typeof a.data.reset).toBe("number");
    expect(a.data.windows).toHaveLength(1);
    expect(a.data.windows[0].note).toMatch(/no durable store/);
    expect(a.meta.requestId).toBe(first.headers.get("X-Request-Id"));
    // Body/header parity: the stub headers mirror the snapshot, not statics.
    expect(first.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(first.headers.get("X-RateLimit-Reset")).toBe(String(a.data.reset));
    const second = await handleQuota(req("http://x/api/v1/quota"));
    expect((await second.json()).data.remaining).toBe(98);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("98");
  });

  test("window rolls over after 60s", () => {
    expect(getQuotaSnapshot(1_000_000).used).toBe(1);
    expect(getQuotaSnapshot(1_000_001).used).toBe(2);
    expect(getQuotaSnapshot(1_000_000 + 60_000).used).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI: full spec registration
// ---------------------------------------------------------------------------

describe("phase 10 openapi registration", () => {
  test("all six utils paths documented with operation ids", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        {
          get?: { operationId: string; responses: Record<string, unknown> };
          post?: { operationId: string; responses: Record<string, unknown> };
        }
      >;
    };
    const expected: Record<string, ["get" | "post", string]> = {
      "/channels/{id}/rss": ["get", "getChannelRss"],
      "/mixes/{id}": ["get", "getMix"],
      "/thumbnails": ["get", "getThumbnails"],
      "/instances": ["get", "getInstances"],
      "/batch": ["post", "postBatch"],
      "/quota": ["get", "getQuota"],
    };
    for (const [path, [method, operationId]] of Object.entries(expected)) {
      expect(doc.paths[path]).toBeDefined();
      expect(doc.paths[path][method]?.operationId).toBe(operationId);
      expect(Object.keys(doc.paths[path][method]?.responses ?? {})).toContain(
        "200",
      );
    }
    const rssResponses = doc.paths["/channels/{id}/rss"]?.get
      ?.responses as Record<string, { content?: Record<string, unknown> }>;
    expect(Object.keys(rssResponses["200"]?.content ?? {})).toContain(
      "application/rss+xml",
    );
    expect(Object.keys(doc.paths)).toHaveLength(37);
  });

  test("mixes spec pattern mirrors parseMixSeed boundaries", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        { get: { parameters: Array<{ schema: { pattern: string } }> } }
      >;
    };
    const pattern = new RegExp(
      doc.paths["/mixes/{id}"]?.get.parameters[0]?.schema.pattern ?? "^$",
    );
    // Mirrors parseMixSeed: RD + 1..62 chars, or any 5..64-char seed id.
    for (const ok of ["RDa", `RD${VID}`, VID, "abcde"]) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of ["RD", "abcd", "!!!", ""]) {
      expect(pattern.test(bad)).toBe(false);
    }
  });
});
