import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleHealth } from "../../app/api/v1/health/route";
import { handleSearch, type SearchDeps } from "../../app/api/v1/search/route";
import { handleGetVideo } from "../../app/api/v1/videos/[id]/route";
import { clearCache } from "../cache";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import type { VideoDetailsDTO } from "../mappers";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

function req(url: string): NextRequest {
  return new NextRequest(url);
}

/** Fake youtubei Search over fixed node pages; continuation appends pages. */
function fakeSearch(
  pages: Array<Array<Record<string, unknown>>>,
): ContinuationSearch {
  let idx = 0;
  const search: ContinuationSearch = {
    results: [...(pages[0] ?? [])],
    has_continuation: pages.length > 1,
    getContinuation: async () => {
      idx += 1;
      search.results = [...search.results, ...(pages[idx] ?? [])];
      search.has_continuation = idx < pages.length - 1;
    },
  };
  return search;
}

const node = (id: string, title: string) => ({ type: "Video", id, title });

describe("health handler (mocked session)", () => {
  test("ready when session establishes", async () => {
    const res = await handleHealth("h1", { checkSession: async () => {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, session: "ready" });
    expect(body.meta.requestId).toBe("h1");
    expect(res.headers.get("X-Request-Id")).toBe("h1");
  });

  test("degraded 200 + warnings when session fails (never 500)", async () => {
    const res = await handleHealth("h2", {
      checkSession: async () => {
        throw new Error("LOGIN_REQUIRED");
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.session).toBe("degraded");
    expect(body.warnings[0].code).toBe("session_degraded");
  });
});

describe("search handler (mocked upstream)", () => {
  const deps: SearchDeps = {
    runSearch: async (q) =>
      fakeSearch([
        [node(`${q}-1`, "T1"), node(`${q}-2`, "T2")],
        [node(`${q}-3`, "T3")],
      ]),
    continueSearch: async (s) => {
      await s.getContinuation();
    },
  };

  test("missing q without cursor -> 400 missing_query, upstream untouched", async () => {
    let called = false;
    const res = await handleSearch(req("http://x/api/v1/search"), {
      runSearch: async () => {
        called = true;
        throw new Error("must not run");
      },
      continueSearch: async () => {},
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("missing_query");
    expect(called).toBe(false);
  });

  test("cursor request skips q/type validation", async () => {
    // No q at all: unknown cursor -> [] + next: null (never 400/404).
    const res = await handleSearch(
      req("http://x/api/v1/search?cursor=nope-no-q"),
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("cursor request with invalid limit -> 400 invalid_limit", async () => {
    const res = await handleSearch(
      req("http://x/api/v1/search?cursor=abc&limit=many"),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("first page maps DTOs and mints a cursor; cursor walks page 2", async () => {
    const first = await handleSearch(
      req("http://x/api/v1/search?q=walk&limit=2"),
      deps,
    );
    const b1 = await first.json();
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual([
      "walk-1",
      "walk-2",
    ]);
    expect(typeof b1.page.next).toBe("string");

    const second = await handleSearch(
      req(`http://x/api/v1/search?cursor=${b1.page.next}&limit=2`),
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["walk-3"]);
    expect(b2.page.next).toBeNull();
  });

  test("evicted cursor on a cache hit degrades to next: null (never dangles)", async () => {
    const url = "http://x/api/v1/search?q=dangle&limit=2";
    const b1 = await (await handleSearch(req(url), deps)).json();
    expect(typeof b1.page.next).toBe("string");
    // Simulate eviction / cross-instance loss of the continuation entry.
    clearContinuations();
    const b2 = await (await handleSearch(req(url), deps)).json();
    expect(b2.meta.cached).toBe(true);
    expect(b2.data).toEqual(b1.data);
    expect(b2.page.next).toBeNull();
  });

  test("upstream failure -> 502 upstream_degraded with hint", async () => {
    const res = await handleSearch(req("http://x/api/v1/search?q=boom"), {
      runSearch: async () => {
        throw new Error("upstream down");
      },
      continueSearch: async () => {},
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
  });

  test("continuation failure -> [] + next: null with warning", async () => {
    const b1 = await (
      await handleSearch(req("http://x/api/v1/search?q=failcont&limit=2"), deps)
    ).json();
    const res = await handleSearch(
      req(`http://x/api/v1/search?cursor=${b1.page.next}&limit=2`),
      {
        ...deps,
        continueSearch: async () => {
          throw new Error("gone");
        },
      },
    );
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
    expect(body.warnings[0].code).toBe("continuation_failed");
  });
});

describe("videos handler (mocked upstream)", () => {
  const dto: VideoDetailsDTO = {
    id: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    channel: { id: "UCabc", name: "Rick" },
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let called = false;
    const res = await handleGetVideo(req("http://x/api/v1/videos/!!!"), "!!!", {
      fetchVideo: async () => {
        called = true;
        return dto;
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(called).toBe(false);
  });

  test("NOT_FOUND -> 404 video_not_found", async () => {
    const res = await handleGetVideo(
      req("http://x/api/v1/videos/AAAAAAAAAAA"),
      "AAAAAAAAAAA",
      {
        fetchVideo: async () => {
          throw new Error("NOT_FOUND: video");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("video_not_found");
  });

  test("LOGIN_REQUIRED -> 502 upstream_degraded", async () => {
    const res = await handleGetVideo(
      req("http://x/api/v1/videos/BBBBBBBBBBB"),
      "BBBBBBBBBBB",
      {
        fetchVideo: async () => {
          throw new Error("LOGIN_REQUIRED: bot-guard");
        },
      },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_degraded");
  });

  test("timeout -> 504 upstream_timeout", async () => {
    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const res = await handleGetVideo(
      req("http://x/api/v1/videos/CCCCCCCCCCC"),
      "CCCCCCCCCCC",
      {
        fetchVideo: async () => {
          throw err;
        },
      },
    );
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
  });

  test("region/lang are echo-only: shared cache entry, meta echoes request", async () => {
    let calls = 0;
    const deps = {
      fetchVideo: async (id: string) => {
        calls += 1;
        return { ...dto, id };
      },
    };
    const r1 = await handleGetVideo(
      req("http://x/api/v1/videos/dQw4w9WgXcQ?region=US"),
      "dQw4w9WgXcQ",
      deps,
    );
    const b1 = await r1.json();
    expect(b1.data.title).toBe("Never Gonna Give You Up");
    expect(b1.page.next).toBeNull();

    const r2 = await handleGetVideo(
      req("http://x/api/v1/videos/dQw4w9WgXcQ?region=DE&lang=de"),
      "dQw4w9WgXcQ",
      deps,
    );
    const b2 = await r2.json();
    expect(calls).toBe(1);
    expect(b2.data).toEqual(b1.data);
    expect(b2.meta.region).toBe("DE");
    expect(b2.meta.lang).toBe("de");
    expect(b2.meta.cached).toBe(true);
  });
});
