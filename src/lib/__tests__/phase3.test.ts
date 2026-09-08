import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleHashtag } from "../../app/api/v1/hashtags/[tag]/route";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { handleSuggestions } from "../../app/api/v1/search/suggestions/route";
import { cacheSet, clearCache } from "../cache";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import {
  classifyHashtagError,
  isUpstreamTimeout,
  mapSearchItem,
} from "../mappers";
import { parseHashtagTag, parseSuggestionsParams } from "../validate";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

function req(url: string, requestId = "phase3"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

/** Fake immutable feed pages (mirrors youtubei: getContinuation returns a
 * NEW page object per call, never mutates the source). */
function fakeFeed(pages: Array<unknown[]>): ContinuationSearch {
  const page = (idx: number): ContinuationSearch => ({
    results: [...(pages[idx] ?? [])],
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => page(idx + 1),
  });
  return page(0);
}

const vid = (id: string, title: string) => ({ type: "Video", id, title });

/** Fake raw HashtagFeed page (pre-adaptation shape): RichGrid of RichItems. */
function fakeRawHashtag(
  pages: Array<unknown[]>,
  idx = 0,
): {
  contents: { contents: Array<{ content: unknown }> };
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
} {
  return {
    contents: {
      contents: (pages[idx] ?? []).map((c) => ({ content: c })),
    },
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => fakeRawHashtag(pages, idx + 1),
  };
}

describe("suggestions validator", () => {
  test("missing/blank q -> 400 missing_query", () => {
    for (const url of ["http://x/s?q=", "http://x/s", "http://x/s?q=++"]) {
      const parsed = parseSuggestionsParams(new URL(url).searchParams);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("missing_query");
        expect(parsed.error.status).toBe(400);
        expect(typeof parsed.error.hint).toBe("string");
      }
    }
  });

  test("invalid limit -> null-shaped invalid_limit", () => {
    const parsed = parseSuggestionsParams(
      new URL("http://x/s?q=lofi&limit=many").searchParams,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("invalid_limit");
    }
  });

  test("ok parses q/limit with region/lang defaults and trims q", () => {
    const parsed = parseSuggestionsParams(
      new URL("http://x/s?q=%20lofi%20&limit=5").searchParams,
    );
    expect(parsed).toEqual({
      ok: true,
      value: { q: "lofi", limit: 5, region: "US", lang: "en" },
    });
  });
});

describe("hashtag tag validator", () => {
  test("strips one leading #", () => {
    expect(parseHashtagTag("#lofi")).toEqual({ ok: true, value: "lofi" });
    expect(parseHashtagTag("lofi")).toEqual({ ok: true, value: "lofi" });
  });

  test("rejects empty, double-hash, bad chars, and overlong tags", () => {
    for (const bad of [
      "",
      "#",
      "##lofi",
      "lo fi",
      "lofi!",
      "a/b",
      "a.b",
      "a".repeat(65),
    ]) {
      const parsed = parseHashtagTag(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("invalid_hashtag");
        expect(parsed.error.status).toBe(400);
        expect(typeof parsed.error.hint).toBe("string");
      }
    }
  });

  test("accepts word chars, hyphens, and unicode letters up to 64", () => {
    expect(parseHashtagTag("lofi_2024").ok).toBe(true);
    expect(parseHashtagTag("a".repeat(64)).ok).toBe(true);
    expect(parseHashtagTag("lo-fi")).toEqual({ ok: true, value: "lo-fi" });
    expect(parseHashtagTag("#hip-hop")).toEqual({ ok: true, value: "hip-hop" });
    expect(parseHashtagTag("音楽").ok).toBe(true);
  });

  test("accepts combining marks: decomposed accents and Hindi matras", () => {
    // e + U+0301 (combining acute) — NFD form of é.
    expect(parseHashtagTag("cafe\u0301").ok).toBe(true);
    expect(parseHashtagTag("संगीत").ok).toBe(true);
  });
});

describe("phase 3 mappers", () => {
  test("Shorts-shaped nodes map to video when an id is resolvable", () => {
    expect(
      mapSearchItem({
        type: "ShortsLockupView",
        video_id: "short1abc12",
        title: { text: "Short" },
      }),
    ).toMatchObject({ id: "short1abc12", kind: "video" });
    expect(
      mapSearchItem({
        type: "GridVideo",
        video_id: "grid1abc123",
        title: { text: "Grid" },
      }),
    ).toMatchObject({ id: "grid1abc123", kind: "video" });
    expect(
      mapSearchItem({
        type: "ReelItem",
        id: "reel1abc123",
        title: { text: "Reel" },
      }),
    ).toMatchObject({ id: "reel1abc123", kind: "video" });
  });

  test("Shorts-shaped nodes without an id still map to null", () => {
    expect(
      mapSearchItem({ type: "ShortsLockupView", title: { text: "No id" } }),
    ).toBeNull();
    expect(mapSearchItem({ type: "ReelItem", title: "No id" })).toBeNull();
  });

  test("classifyHashtagError: 404 / 504 / 502", () => {
    expect(
      classifyHashtagError(new Error("hashtag not found: xyz")),
    ).toMatchObject({ code: "hashtag_not_found", status: 404 });
    // Signal BEFORE "hashtag" also 404s.
    expect(
      classifyHashtagError(new Error("NOT_FOUND: hashtag page")),
    ).toMatchObject({ code: "hashtag_not_found", status: 404 });
    expect(
      classifyHashtagError(new Error("No videos found for #xyz")),
    ).toMatchObject({ code: "hashtag_not_found", status: 404 });
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(classifyHashtagError(timeout)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    expect(classifyHashtagError(new Error("upstream down"))).toMatchObject({
      code: "upstream_degraded",
      status: 502,
    });
  });

  test("timeout wins over not-found-ish text; generic 404-ish stays 502", () => {
    const both = new Error(
      "Upstream timed out after 8000ms while checking hashtag not found",
    );
    both.name = "TimeoutError";
    expect(classifyHashtagError(both)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    // No hashtag/feed context -> never hashtag_not_found.
    expect(classifyHashtagError(new Error("NOT_FOUND: video"))).toMatchObject({
      code: "upstream_degraded",
      status: 502,
    });
    expect(
      classifyHashtagError(new Error("request failed with status 404")),
    ).toMatchObject({ code: "upstream_degraded", status: 502 });
  });

  test("transient error merely mentioning 'hashtag page' stays 502/504", () => {
    // A parse/render failure on the tag page is transient: it must not
    // become a definitive hashtag_not_found (which would 404 and refuse
    // stale). Only explicit not-found signals in hashtag context 404.
    expect(
      classifyHashtagError(
        new Error("failed to parse hashtag page: bad token"),
      ),
    ).toMatchObject({ code: "upstream_degraded", status: 502 });
    const slow = new Error("timed out loading hashtag page");
    slow.name = "TimeoutError";
    expect(classifyHashtagError(slow)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    expect(
      classifyHashtagError(new Error("hashtag feed unavailable for xyz")),
    ).toMatchObject({ code: "hashtag_not_found", status: 404 });
  });
});

describe("shared isUpstreamTimeout helper (search + suggestions)", () => {
  test("timeout/abort signals true; anything else false", () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(isUpstreamTimeout(timeout)).toBe(true);
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isUpstreamTimeout(abort)).toBe(true);
    expect(isUpstreamTimeout(new Error("upstream down"))).toBe(false);
    expect(isUpstreamTimeout("plain string")).toBe(false);
  });
});

describe("suggestions handler (mocked upstream)", () => {
  const deps = {
    getSuggestions: async (q: string) => [
      `${q} mix`,
      `${q} beats`,
      `${q} live`,
    ],
  };

  test("missing q -> 400 missing_query, upstream untouched", async () => {
    let called = false;
    const res = await handleSuggestions(
      req("http://x/api/v1/search/suggestions"),
      {
        getSuggestions: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("missing_query");
    expect(called).toBe(false);
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handleSuggestions(
      req("http://x/api/v1/search/suggestions?q=lofi&limit=many"),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("success envelope: data + page.next null + meta + headers", async () => {
    const res = await handleSuggestions(
      req("http://x/api/v1/search/suggestions?q=lofi&limit=2"),
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(["lofi mix", "lofi beats"]);
    expect(body.page).toEqual({ next: null });
    expect(body.meta).toMatchObject({
      region: "US",
      lang: "en",
      cached: false,
      requestId: "phase3",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("X-Request-Id")).toBe("phase3");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
  });

  test("limit clamps to 50", async () => {
    const many = {
      getSuggestions: async () => Array.from({ length: 60 }, (_, i) => `s${i}`),
    };
    const body = await (
      await handleSuggestions(
        req("http://x/api/v1/search/suggestions?q=lofi&limit=100"),
        many,
      )
    ).json();
    expect(body.data).toHaveLength(50);
  });

  test("region/lang echo in meta", async () => {
    const body = await (
      await handleSuggestions(
        req("http://x/api/v1/search/suggestions?q=lofi&region=DE&lang=de"),
        deps,
      )
    ).json();
    expect(body.meta.region).toBe("DE");
    expect(body.meta.lang).toBe("de");
  });

  test("stale-on-error: upstream failure with stale copy -> 200 + stale_served", async () => {
    const primed = await (
      await handleSuggestions(
        req("http://x/api/v1/search/suggestions?q=lof"),
        deps,
      )
    ).json();
    expect(primed.data).toHaveLength(3);
    // Age the L0 entry past its fresh window so the next fetch failure
    // serves stale instead of throwing.
    cacheSet("suggestions:v1:US:en:20:lof", primed.data, -1, 30 * 60 * 1000);
    const res = await handleSuggestions(
      req("http://x/api/v1/search/suggestions?q=lof"),
      {
        getSuggestions: async () => {
          throw new Error("upstream down");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("timeout -> 504 upstream_timeout; generic -> 502 upstream_degraded", async () => {
    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handleSuggestions(
      req("http://x/api/v1/search/suggestions?q=slow"),
      {
        getSuggestions: async () => {
          throw err;
        },
      },
    );
    expect(to.status).toBe(504);
    expect((await to.json()).error.code).toBe("upstream_timeout");

    const down = await handleSuggestions(
      req("http://x/api/v1/search/suggestions?q=boom"),
      {
        getSuggestions: async () => {
          throw new Error("upstream down");
        },
      },
    );
    expect(down.status).toBe(502);
    expect((await down.json()).error.code).toBe("upstream_degraded");
  });
});

describe("hashtag handler (mocked upstream)", () => {
  const deps = {
    fetchFirstPage: async (_tag: string) =>
      fakeFeed([[vid("h1", "H1"), vid("h2", "H2")], [vid("h3", "H3")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };

  test("invalid tag -> 400 invalid_hashtag, upstream untouched", async () => {
    let called = false;
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/x"),
      "lo-fi!",
      {
        fetchFirstPage: async () => {
          called = true;
          throw new Error("must not run");
        },
        continueFeed: async () => {
          throw new Error("must not continue");
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_hashtag");
    expect(called).toBe(false);
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=many"),
      "lofi",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("unknown cursor -> [] + next: null (never 404)", async () => {
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?cursor=nope"),
      "lofi",
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("empty upstream feed -> 200 data:[] + next:null (never 404)", async () => {
    const empty = {
      fetchFirstPage: async (_tag: string) => fakeFeed([[]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=5"),
      "lofi",
      empty,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("stale + definitive not-found -> 404 (never serves stale)", async () => {
    const primed = await (
      await handleHashtag(
        req("http://x/api/v1/hashtags/lofi?limit=2"),
        "lofi",
        deps,
      )
    ).json();
    expect(primed.data).toHaveLength(2);
    // Age the L0 entry past its fresh window: a transient failure would
    // serve it stale, but a definitive hashtag_not_found must propagate.
    cacheSet(
      "hashtag:v1:lofi:2",
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=2"),
      "lofi",
      {
        fetchFirstPage: async () => {
          throw new Error("hashtag not found: xyz");
        },
        continueFeed: async () => {
          throw new Error("must not continue");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("hashtag_not_found");
  });

  test("first page maps DTOs, mints cursor; cursor walks page 2", async () => {
    const first = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=2"),
      "lofi",
      deps,
    );
    expect(first.status).toBe(200);
    const b1 = await first.json();
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual(["h1", "h2"]);
    expect(b1.data[0].kind).toBe("video");
    expect(typeof b1.page.next).toBe("string");
    expect(b1.meta.requestId).toBe("phase3");
    expect(first.headers.get("X-Request-Id")).toBe("phase3");
    expect(first.headers.get("X-RateLimit-Limit")).toBe("100");
    // Page carries a process-local cursor -> private/no-store, never CDN.
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");

    const second = await handleHashtag(
      req(`http://x/api/v1/hashtags/lofi?cursor=${b1.page.next}&limit=2`),
      "lofi",
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["h3"]);
    expect(b2.page.next).toBeNull();
  });

  test("exhausted first page keeps the public hashtag TTL", async () => {
    const single = {
      fetchFirstPage: async (_tag: string) => fakeFeed([[vid("only", "Only")]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=5"),
      "lofi",
      single,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
    const body = await res.json();
    expect(body.page.next).toBeNull();
  });

  test("cross-tag cursor -> [] + next: null (never foreign items)", async () => {
    const b1 = await (
      await handleHashtag(
        req("http://x/api/v1/hashtags/lofi?limit=2"),
        "lofi",
        deps,
      )
    ).json();
    expect(typeof b1.page.next).toBe("string");
    const cross = await handleHashtag(
      req(`http://x/api/v1/hashtags/jazz?cursor=${b1.page.next}&limit=2`),
      "jazz",
      deps,
    );
    const body = await cross.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("tag matching is case-insensitive (# stripped, lowercased scope)", async () => {
    const lower = await (
      await handleHashtag(
        req("http://x/api/v1/hashtags/lofi?limit=2"),
        "lofi",
        deps,
      )
    ).json();
    const upper = await (
      await handleHashtag(
        req("http://x/api/v1/hashtags/LOFI?limit=2"),
        "LOFI",
        deps,
      )
    ).json();
    expect(upper.meta.cached).toBe(true);
    expect(upper.data).toEqual(lower.data);
    // Cross-case cursor still resolves (same lowercased scope).
    const walk = await (
      await handleHashtag(
        req(`http://x/api/v1/hashtags/LOFI?cursor=${lower.page.next}&limit=2`),
        "LOFI",
        deps,
      )
    ).json();
    expect(walk.data.map((d: { id: string }) => d.id)).toEqual(["h3"]);
  });

  test("two identical queries get independent cursors (no shared mutation)", async () => {
    const url = "http://x/api/v1/hashtags/lofi?limit=1";
    const b1 = await (await handleHashtag(req(url), "lofi", deps)).json();
    const b2 = await (await handleHashtag(req(url), "lofi", deps)).json();
    expect(b2.meta.cached).toBe(true);
    expect(b2.page.next).not.toBe(b1.page.next);
    const w1 = await (
      await handleHashtag(
        req(`http://x/api/v1/hashtags/lofi?cursor=${b1.page.next}&limit=1`),
        "lofi",
        deps,
      )
    ).json();
    const w2 = await (
      await handleHashtag(
        req(`http://x/api/v1/hashtags/lofi?cursor=${b2.page.next}&limit=1`),
        "lofi",
        deps,
      )
    ).json();
    expect(w1.data.map((d: { id: string }) => d.id)).toEqual(["h2"]);
    expect(w2.data.map((d: { id: string }) => d.id)).toEqual(["h2"]);
  });

  test("stale-on-error: upstream failure with stale copy -> 200 + stale_served", async () => {
    const primed = await (
      await handleHashtag(
        req("http://x/api/v1/hashtags/lofi?limit=2"),
        "lofi",
        deps,
      )
    ).json();
    cacheSet(
      "hashtag:v1:lofi:2",
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const res = await handleHashtag(
      req("http://x/api/v1/hashtags/lofi?limit=2"),
      "lofi",
      {
        fetchFirstPage: async () => {
          throw new Error("upstream down");
        },
        continueFeed: async () => {
          throw new Error("must not continue");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("NOT_FOUND -> 404 hashtag_not_found; timeout -> 504", async () => {
    const nf = await handleHashtag(
      req("http://x/api/v1/hashtags/nope"),
      "nope",
      {
        fetchFirstPage: async () => {
          throw new Error("hashtag not found: xyz");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("hashtag_not_found");

    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handleHashtag(
      req("http://x/api/v1/hashtags/slow"),
      "slow",
      {
        fetchFirstPage: async () => {
          throw err;
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(to.status).toBe(504);
    expect((await to.json()).error.code).toBe("upstream_timeout");
  });

  test("adaptHashtag unwraps RichItem content and re-adapts continuations", async () => {
    const { adaptHashtag } = await import(
      "../../app/api/v1/hashtags/[tag]/route"
    );
    const raw = fakeRawHashtag([[vid("r1", "R1")], [vid("r2", "R2")]]);
    const first = adaptHashtag(raw);
    expect(first.results).toEqual([vid("r1", "R1")]);
    expect(first.has_continuation).toBe(true);
    const second = await first.getContinuation();
    expect(second.results).toEqual([vid("r2", "R2")]);
    expect(second.has_continuation).toBe(false);
  });
});

describe("openapi phase 3", () => {
  test("lists /search/suggestions and /hashtags/{tag} with params", () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as unknown as Record<
      string,
      {
        get: {
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
        };
      }
    >;
    expect(Object.keys(paths)).toContain("/search/suggestions");
    expect(Object.keys(paths)).toContain("/hashtags/{tag}");
    expect(
      paths["/search/suggestions"].get.parameters.map((q) => q.name),
    ).toEqual(expect.arrayContaining(["q", "limit", "region", "lang"]));
    expect(paths["/hashtags/{tag}"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining(["tag", "limit", "cursor", "region", "lang"]),
    );
    for (const p of ["/search/suggestions", "/hashtags/{tag}"]) {
      const codes = Object.keys(paths[p].get.responses);
      for (const c of ["200", "400", "429", "502", "504"]) {
        expect(codes).toContain(c);
      }
    }
    expect(Object.keys(paths["/hashtags/{tag}"].get.responses)).toContain(
      "404",
    );
  });
});
