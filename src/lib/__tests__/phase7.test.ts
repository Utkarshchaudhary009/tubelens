import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleFeedGaming } from "../../app/api/v1/feed/gaming/route";
import { handleFeedLive } from "../../app/api/v1/feed/live/route";
import { handleFeedShorts } from "../../app/api/v1/feed/shorts/route";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { cacheSet, clearCache } from "../cache";
import { clearContinuations, storeContinuation } from "../continuations";
import {
  type ContinuationSearch,
  classifyExploreFeedError,
  FEED_SEED_QUERY,
  type FeedDeps,
  type FeedKind,
  feedCacheKey,
  feedScope,
} from "../feed";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

function req(url: string, requestId = "phase7"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

/** Fake immutable feed pages (mirrors Search.getContinuation). */
function fakeFeedPage(
  rows: unknown[],
  hasMore = false,
  next: ContinuationSearch | null = null,
): ContinuationSearch {
  return {
    results: rows,
    has_continuation: hasMore,
    getContinuation: async () => next ?? fakeFeedPage([], false),
  };
}

const thumbs = { thumbnails: [{ url: "https://i/thumb" }] };

const videoRow = (id: string, title: string) => ({
  type: "Video",
  video_id: id,
  title,
  author: { name: "Some Channel", id: "UC_somechannel00000001" },
  ...thumbs,
});

const liveRow = (id: string) => ({
  type: "Video",
  video_id: id,
  title: "Live right now",
  is_live: true,
  view_count: { text: "1.2K watching" },
  author: { name: "Live Channel", id: "UC_livechannel00000001" },
  ...thumbs,
});

const upcomingRow = (id: string) => ({
  type: "Video",
  video_id: id,
  title: "Starting soon",
  upcoming: new Date("2026-09-10T00:00:00.000Z"),
  author: { name: "Soon Channel", id: "UC_soonchannel00000001" },
  ...thumbs,
});

function feedDeps(rows: unknown[], hasMore = false): FeedDeps {
  return {
    fetchFirstPage: async () => fakeFeedPage(rows, hasMore),
    continueFeed: async (page) => page.getContinuation(),
  };
}

const handlers: Record<
  FeedKind,
  (req: NextRequest, deps?: FeedDeps) => Promise<Response>
> = {
  shorts: (r, d) => handleFeedShorts(r, d ?? feedDeps([])),
  live: (r, d) => handleFeedLive(r, d ?? feedDeps([])),
  gaming: (r, d) => handleFeedGaming(r, d ?? feedDeps([])),
};

describe("phase 7 feed scaffolding", () => {
  test("seed queries are fixed and documented per feed", () => {
    expect(FEED_SEED_QUERY).toEqual({
      shorts: "shorts",
      live: "live",
      gaming: "gaming",
    });
  });

  test("scopes isolate the three feeds", () => {
    expect(
      new Set([feedScope("shorts"), feedScope("live"), feedScope("gaming")])
        .size,
    ).toBe(3);
    expect(feedScope("shorts")).toBe("feed:shorts");
    expect(feedScope("live")).toBe("feed:live");
    expect(feedScope("gaming")).toBe("feed:gaming");
  });

  test("error classifier: timeout is 504, generic failure is 502", () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    for (const kind of ["shorts", "live", "gaming"] as const) {
      expect(classifyExploreFeedError(kind, timeout).status).toBe(504);
      expect(classifyExploreFeedError(kind, timeout).code).toBe(
        "upstream_timeout",
      );
      const down = classifyExploreFeedError(kind, new Error("socket hang up"));
      expect(down.status).toBe(502);
      expect(down.code).toBe("upstream_degraded");
    }
  });
});

describe.each([["shorts"], ["live"], ["gaming"]] as Array<
  [FeedKind]
>)("feed/%s envelope and validation", (kind) => {
  const handler = handlers[kind];

  test("invalid limit is a 400 with invalid_limit", async () => {
    const res = await handler(
      req(`http://x/api/v1/feed/${kind}?limit=abc`),
      feedDeps([]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_limit");
    expect(typeof body.error.hint).toBe("string");
  });

  test("first page carries the envelope, request id, and region/lang echo", async () => {
    const rows =
      kind === "live"
        ? [liveRow("l1"), upcomingRow("l2")]
        : [videoRow("v1", "A")];
    const res = await handler(
      req(`http://x/api/v1/feed/${kind}?limit=2&region=de&lang=fr`),
      feedDeps(rows),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(rows.length);
    expect(body.page.next).toBeNull();
    expect(body.meta).toMatchObject({
      region: "DE",
      lang: "fr",
      cached: false,
      requestId: "phase7",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("x-request-id")).toBe("phase7");
  });

  test("exhausted first page keeps the public fast-moving TTL", async () => {
    const res = await handler(
      req(`http://x/api/v1/feed/${kind}?limit=5`),
      feedDeps([]),
    );
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain(kind === "live" ? "s-maxage=300" : "s-maxage=600");
    expect(cc).toContain("stale-while-revalidate=3600");
  });

  test("cursor-carrying first page is private no-store", async () => {
    const rows =
      kind === "live"
        ? [liveRow("l1"), liveRow("l2"), upcomingRow("l3")]
        : [videoRow("v1", "A"), videoRow("v2", "B"), videoRow("v3", "C")];
    const res = await handler(
      req(`http://x/api/v1/feed/${kind}?limit=2`),
      feedDeps(rows),
    );
    const body = await res.json();
    expect(typeof body.page.next).toBe("string");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("cursor walk serves buffered items then terminates", async () => {
    const rows =
      kind === "live"
        ? [liveRow("l1"), liveRow("l2"), upcomingRow("l3")]
        : [videoRow("v1", "A"), videoRow("v2", "B"), videoRow("v3", "C")];
    const first = await handler(
      req(`http://x/api/v1/feed/${kind}?limit=2`),
      feedDeps(rows),
    );
    const firstBody = await first.json();
    expect(firstBody.data.map((d: { id: string }) => d.id)).toEqual(
      kind === "live" ? ["l1", "l2"] : ["v1", "v2"],
    );
    const second = await handler(
      req(`http://x/api/v1/feed/${kind}?cursor=${firstBody.page.next}&limit=2`),
      feedDeps(rows),
    );
    const secondBody = await second.json();
    expect(secondBody.data.map((d: { id: string }) => d.id)).toEqual(
      kind === "live" ? ["l3"] : ["v3"],
    );
    expect(secondBody.page.next).toBeNull();
    expect(second.headers.get("cache-control")).toBe("private, no-store");
  });

  test("unknown cursor yields an empty page, never an error", async () => {
    const res = await handler(
      req(`http://x/api/v1/feed/${kind}?cursor=ghost`),
      feedDeps([]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("repeat calls serve fresh items, second from L0", async () => {
    const rows = kind === "live" ? [liveRow("l1")] : [videoRow("v1", "A")];
    const url = `http://x/api/v1/feed/${kind}?limit=1`;
    const first = await handler(req(url), feedDeps(rows));
    const firstBody = await first.json();
    expect(firstBody.meta.cached).toBe(false);
    const second = await handler(req(url), feedDeps([]));
    const secondBody = await second.json();
    expect(secondBody.data).toEqual(firstBody.data);
    expect(secondBody.meta.cached).toBe(true);
    expect(secondBody.warnings).toEqual([]);
  });

  test("stale-on-error serves cached page with cached:true + warnings", async () => {
    const rows = kind === "live" ? [liveRow("l1")] : [videoRow("v1", "A")];
    const primed = await (
      await handler(req(`http://x/api/v1/feed/${kind}?limit=1`), feedDeps(rows))
    ).json();
    cacheSet(
      feedCacheKey(kind, 1),
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handler(req(`http://x/api/v1/feed/${kind}?limit=1`), {
      ...feedDeps([]),
      fetchFirstPage: async () => {
        const err = new Error("Upstream timed out after 8000ms");
        err.name = "TimeoutError";
        throw err;
      },
    });
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("upstream timeout is a 504, generic failure a 502", async () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    const to = await handler(req(`http://x/api/v1/feed/${kind}`), {
      ...feedDeps([]),
      fetchFirstPage: async () => {
        throw timeout;
      },
    });
    expect(to.status).toBe(504);
    expect((await to.json()).error.code).toBe("upstream_timeout");

    const down = await handler(req(`http://x/api/v1/feed/${kind}`), {
      ...feedDeps([]),
      fetchFirstPage: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(down.status).toBe(502);
  });
});

describe("feed/live stream fields", () => {
  test("live items carry viewer counts, upcoming items scheduled times", async () => {
    const res = await handleFeedLive(
      req("http://x/api/v1/feed/live?limit=2"),
      feedDeps([liveRow("l1"), upcomingRow("l2")]),
    );
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: "l1",
      isLive: true,
      isUpcoming: false,
      viewersText: "1.2K watching",
    });
    expect(body.data[1]).toMatchObject({
      id: "l2",
      isLive: false,
      isUpcoming: true,
      scheduledStart: "2026-09-10T00:00:00.000Z",
    });
  });
});

describe("feed scope isolation", () => {
  const pairs: Array<[FeedKind, FeedKind]> = [
    ["shorts", "live"],
    ["live", "gaming"],
    ["gaming", "shorts"],
  ];
  for (const [from, to] of pairs) {
    test(`${from}-scoped cursor presented to ${to} yields an empty page`, async () => {
      const foreign = storeContinuation(
        fakeFeedPage([videoRow("v9", "Z")]),
        0,
        feedScope(from),
      );
      const res = await handlers[to](
        req(`http://x/api/v1/feed/${to}?cursor=${foreign}`),
        feedDeps([]),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.page.next).toBeNull();
    });
  }
});

describe("openapi lists the phase 7 feeds", () => {
  test("all three feed routes are documented", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, unknown>;
    };
    for (const p of ["/feed/shorts", "/feed/live", "/feed/gaming"]) {
      expect(doc.paths[p]).toBeDefined();
    }
  });
});
