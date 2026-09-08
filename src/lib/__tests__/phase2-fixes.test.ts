import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleSearch } from "../../app/api/v1/search/route";
import { handleCaptions } from "../../app/api/v1/videos/[id]/captions/route";
import { handleComments } from "../../app/api/v1/videos/[id]/comments/route";
import { handleRelated } from "../../app/api/v1/videos/[id]/related/route";
import { handleTranscript } from "../../app/api/v1/videos/[id]/transcript/route";
import { cacheGet, cacheSet, clearCache } from "../cache";
import {
  type ContinuationSearch,
  clearContinuations,
  forkContinuation,
  storeContinuation,
  takeContinuation,
} from "../continuations";
import {
  classifyCaptionsError,
  classifyFeedError,
  classifyTranscriptError,
} from "../mappers";

// ---------------------------------------------------------------------------
// Finding 1 (HIGH): single 8s fail-fast budget. The default deps lazily import
// "@/lib/youtube", so mocking that specifier intercepts the fetch body without
// ever loading the server-only singleton. The mocked withTimeout records every
// call — a single-budget fetch must call it exactly once with 8000ms.
// ---------------------------------------------------------------------------

const timeoutCalls: number[] = [];
let fakeInnertube: Record<string, (...args: never[]) => Promise<unknown>> = {};

mock.module("@/lib/youtube", () => ({
  getInnertube: async () => fakeInnertube,
  withTimeout: async (
    task: (signal: AbortSignal) => Promise<unknown>,
    ms = 8000,
  ) => {
    timeoutCalls.push(ms);
    return task(new AbortController().signal);
  },
}));

beforeEach(() => {
  clearCache();
  clearContinuations();
  timeoutCalls.length = 0;
  fakeInnertube = {};
});

function req(url: string, requestId = "phase2-fixes"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

function fakeFeed(pages: Array<unknown[]>): ContinuationSearch {
  const page = (idx: number): ContinuationSearch => ({
    results: [...(pages[idx] ?? [])],
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => page(idx + 1),
  });
  return page(0);
}

const vid = (id: string, title: string) => ({ type: "Video", id, title });
const thread = (id: string, text: string) => ({
  type: "CommentThread",
  comment: {
    comment_id: id,
    content: { text },
    author: { id: `author-${id}`, name: `Author ${id}` },
  },
});

describe("finding 1: single 8s upstream budget (default deps)", () => {
  test("related first page uses ONE withTimeout(8000) call", async () => {
    fakeInnertube = {
      getInfo: (async () => ({
        watch_next_feed: [vid("r1", "R1")],
        wn_has_continuation: false,
        getWatchNextContinuation: async () => ({}),
      })) as (...args: never[]) => Promise<unknown>,
    };
    const res = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=1"),
      "dQw4w9WgXcQ",
    );
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([8000]);
  });

  test("comments first page uses ONE withTimeout(8000) call", async () => {
    fakeInnertube = {
      getComments: (async () => ({
        contents: [thread("c1", "hi")],
        has_continuation: false,
        getContinuation: async () => ({}),
      })) as (...args: never[]) => Promise<unknown>,
    };
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=1"),
      "dQw4w9WgXcQ",
    );
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([8000]);
  });

  test("transcript fetch uses ONE withTimeout(8000) call", async () => {
    fakeInnertube = {
      getInfo: (async () => ({
        getTranscript: async () => ({
          transcript: {
            content: {
              body: {
                initial_segments: [
                  { start_ms: "0", end_ms: "1000", snippet: { text: "hi" } },
                ],
              },
            },
          },
        }),
      })) as (...args: never[]) => Promise<unknown>,
    };
    const res = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript"),
      "dQw4w9WgXcQ",
    );
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([8000]);
  });

  test("captions fetch uses ONE withTimeout(8000) call", async () => {
    fakeInnertube = {
      getInfo: (async () => ({
        captions: { caption_tracks: [{ language_code: "en" }] },
      })) as (...args: never[]) => Promise<unknown>,
    };
    const res = await handleCaptions(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/captions"),
      "dQw4w9WgXcQ",
    );
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([8000]);
  });
});

describe("finding 2: empty transcript -> 404 transcript_unavailable", () => {
  test("empty segments (fresh cold miss) -> 404 and caches nothing", async () => {
    const id = "dQw4w9WgXcQ";
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchTranscript: async () => [] },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("transcript_unavailable");
    expect(body.error.hint).toMatch(/hide the transcript panel/i);
    expect(cacheGet(`transcript:v1:${id}`)).toBeUndefined();
  });

  test("fresh-empty with stale copy -> stale wins (200 + warning)", async () => {
    const id = "FFFFFFFFFFF";
    const url = `http://x/api/v1/videos/${id}/transcript`;
    const segments = [{ startSeconds: 0, text: "hi" }];
    const primed = await (
      await handleTranscript(req(url), id, {
        fetchTranscript: async () => segments,
      })
    ).json();
    expect(primed.data).toEqual(segments);
    cacheSet(`transcript:v1:${id}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleTranscript(req(url), id, {
      fetchTranscript: async () => [],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(segments);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("stale-empty copy -> 404, never 200", async () => {
    const id = "GGGGGGGGGGG";
    const url = `http://x/api/v1/videos/${id}/transcript`;
    cacheSet(`transcript:v1:${id}`, [], -1, 60 * 60 * 1000);
    const res = await handleTranscript(req(url), id, {
      fetchTranscript: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("transcript_unavailable");
  });

  test("empty-guard marker maps to 404 transcript_unavailable", () => {
    expect(
      classifyTranscriptError(
        new Error("transcript_unavailable: no transcript segments"),
      ),
    ).toMatchObject({ code: "transcript_unavailable", status: 404 });
  });

  test("stale-nonempty on upstream failure -> 200 + warning", async () => {
    const id = "dQw4w9WgXcQ";
    const url = `http://x/api/v1/videos/${id}/transcript`;
    const segments = [{ startSeconds: 0, text: "hi" }];
    const primed = await (
      await handleTranscript(req(url), id, {
        fetchTranscript: async () => segments,
      })
    ).json();
    expect(primed.data).toEqual(segments);
    cacheSet(`transcript:v1:${id}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleTranscript(req(url), id, {
      fetchTranscript: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(segments);
    expect(body.warnings[0].code).toBe("stale_served");
  });
});

describe("finding 3: cursors bound to video id", () => {
  const videoA = "AAAAAAAAAAA";
  const videoB = "BBBBBBBBBBB";

  test("related cursor from video A on video B -> [] + next: null", async () => {
    const deps = {
      fetchFirstPage: async (_id: string) =>
        fakeFeed([[vid("r1", "R1"), vid("r2", "R2")], [vid("r3", "R3")]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const first = await (
      await handleRelated(
        req(`http://x/api/v1/videos/${videoA}/related?limit=2`),
        videoA,
        deps,
      )
    ).json();
    expect(typeof first.page.next).toBe("string");

    const cross = await handleRelated(
      req(
        `http://x/api/v1/videos/${videoB}/related?cursor=${first.page.next}&limit=2`,
      ),
      videoB,
      deps,
    );
    expect(cross.status).toBe(200);
    const crossBody = await cross.json();
    expect(crossBody.data).toEqual([]);
    expect(crossBody.page).toEqual({ next: null });

    // The foreign cursor still works under its own video id.
    const own = await (
      await handleRelated(
        req(
          `http://x/api/v1/videos/${videoA}/related?cursor=${first.page.next}&limit=2`,
        ),
        videoA,
        deps,
      )
    ).json();
    expect(own.data.map((d: { id: string }) => d.id)).toEqual(["r3"]);
  });

  test("comments cursor from video A on video B -> [] + next: null", async () => {
    const deps = {
      fetchFirstPage: async (_id: string) =>
        fakeFeed([[thread("c1", "one"), thread("c2", "two")]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const first = await (
      await handleComments(
        req(`http://x/api/v1/videos/${videoA}/comments?limit=1`),
        videoA,
        deps,
      )
    ).json();
    expect(typeof first.page.next).toBe("string");

    const cross = await (
      await handleComments(
        req(
          `http://x/api/v1/videos/${videoB}/comments?cursor=${first.page.next}&limit=1`,
        ),
        videoB,
        deps,
      )
    ).json();
    expect(cross.data).toEqual([]);
    expect(cross.page).toEqual({ next: null });
  });

  test("continuation store: scoped fork rejects foreign scope", () => {
    const page = fakeFeed([[vid("r1", "R1"), vid("r2", "R2")]]);
    const cursor = storeContinuation(page, 1, videoA);
    if (cursor === null) {
      throw new Error("expected a cursor");
    }
    expect(takeContinuation(cursor)?.scope).toBe(videoA);
    expect(forkContinuation(cursor, videoB)).toBeNull();
    expect(forkContinuation(cursor, videoA)).not.toBeNull();
    // Unscoped (legacy/search) entries still fork under any scope.
    const open = storeContinuation(fakeFeed([[vid("x", "X")]]), 0);
    if (open === null) {
      throw new Error("expected a cursor");
    }
    expect(forkContinuation(open, videoB)).not.toBeNull();
  });
});

describe("finding 4: comments_disabled", () => {
  test("classifyFeedError maps disabled/turned-off/unavailable variants", () => {
    for (const msg of [
      "comments disabled for this video",
      "Comments turned off by the uploader",
      "comment unavailable for this video",
      "Comments are turned off",
      "Comments are disabled",
      "Comments are unavailable for this video",
      "Comments are not available",
      "comments turned-off",
    ]) {
      expect(classifyFeedError(new Error(msg))).toMatchObject({
        code: "comments_disabled",
        status: 404,
      });
    }
    const disabled = classifyFeedError(new Error("comments disabled"));
    expect(typeof disabled.hint).toBe("string");
    expect(disabled.hint.length).toBeGreaterThan(10);
  });

  test("comments handler surfaces 404 comments_disabled, never video_not_found", async () => {
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments"),
      "dQw4w9WgXcQ",
      {
        fetchFirstPage: async () => {
          throw new Error("comments disabled for this video");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("comments_disabled");
    expect(body.error.hint).toMatch(/hide the comments panel/i);
  });

  test("non-comment feed errors still classify as before", () => {
    expect(classifyFeedError(new Error("NOT_FOUND: video"))).toMatchObject({
      code: "video_not_found",
      status: 404,
    });
  });
});

describe("finding 5: empty caption lists never cached, always 404", () => {
  test("empty fetch -> 404 and populates no cache entry", async () => {
    const id = "dQw4w9WgXcQ";
    const res = await handleCaptions(
      req(`http://x/api/v1/videos/${id}/captions`),
      id,
      {
        fetchCaptions: async () => [],
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("captions_disabled");
    expect(cacheGet(`captions:v1:${id}`)).toBeUndefined();
  });

  test("stale-empty copy -> 404, never 200", async () => {
    const id = "EEEEEEEEEEE";
    const url = `http://x/api/v1/videos/${id}/captions`;
    cacheSet(`captions:v1:${id}`, [], -1, 60 * 60 * 1000);
    const res = await handleCaptions(req(url), id, {
      fetchCaptions: async () => {
        throw new Error("403 Forbidden");
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("captions_disabled");
  });

  test("fresh-empty with stale copy -> stale wins (200 + warning)", async () => {
    const id = "DDDDDDDDDDD";
    const url = `http://x/api/v1/videos/${id}/captions`;
    const tracks = [{ languageCode: "en", kind: "manual" as const }];
    const primed = await (
      await handleCaptions(req(url), id, {
        fetchCaptions: async () => tracks,
      })
    ).json();
    expect(primed.data).toEqual(tracks);
    cacheSet(`captions:v1:${id}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleCaptions(req(url), id, {
      fetchCaptions: async () => [],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(tracks);
    expect(body.warnings[0].code).toBe("stale_served");
  });
});

describe("review: narrow captions/transcript classifiers", () => {
  test("private/deleted/unknown videos -> video_not_found, not disabled", () => {
    for (const msg of [
      "This video is private",
      "Video deleted or removed",
      "NOT_FOUND: video",
      "video unavailable",
    ]) {
      expect(classifyCaptionsError(new Error(msg))).toMatchObject({
        code: "video_not_found",
        status: 404,
      });
      expect(classifyTranscriptError(new Error(msg))).toMatchObject({
        code: "video_not_found",
        status: 404,
      });
    }
  });

  test("transient gibberish -> 502 upstream_degraded, timeouts -> 504", () => {
    for (const msg of ["upstream down", "500 Internal Server Error"]) {
      expect(classifyCaptionsError(new Error(msg))).toMatchObject({
        code: "upstream_degraded",
        status: 502,
      });
      expect(classifyTranscriptError(new Error(msg))).toMatchObject({
        code: "upstream_degraded",
        status: 502,
      });
    }
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(classifyCaptionsError(timeout).status).toBe(504);
    expect(classifyTranscriptError(timeout).status).toBe(504);
  });

  test("caption/transcript-specific signals still 404 with their own code", () => {
    expect(
      classifyCaptionsError(new Error("caption unavailable")),
    ).toMatchObject({ code: "captions_disabled", status: 404 });
    expect(
      classifyTranscriptError(new Error("captions disabled")),
    ).toMatchObject({ code: "transcript_unavailable", status: 404 });
  });
});

describe("review: cross-endpoint cursor isolation", () => {
  test("search cursor on related -> [] + next: null, and vice versa", async () => {
    const videoA = "AAAAAAAAAAA";
    const searchDeps = {
      runSearch: async () => fakeFeed([[vid("s1", "S1"), vid("s2", "S2")]]),
      continueSearch: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const relatedDeps = {
      fetchFirstPage: async (_id: string) =>
        fakeFeed([[vid("r1", "R1"), vid("r2", "R2")]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };

    const sFirst = await (
      await handleSearch(
        req("http://x/api/v1/search?q=xscope&limit=1"),
        searchDeps,
      )
    ).json();
    expect(typeof sFirst.page.next).toBe("string");

    // Search cursor presented to related: rejected, foreign cursor untouched.
    const cross = await (
      await handleRelated(
        req(
          `http://x/api/v1/videos/${videoA}/related?cursor=${sFirst.page.next}&limit=1`,
        ),
        videoA,
        relatedDeps,
      )
    ).json();
    expect(cross.data).toEqual([]);
    expect(cross.page).toEqual({ next: null });

    // The search cursor still works under search.
    const own = await (
      await handleSearch(
        req(`http://x/api/v1/search?cursor=${sFirst.page.next}&limit=1`),
        searchDeps,
      )
    ).json();
    expect(own.data.map((d: { id: string }) => d.id)).toEqual(["s2"]);

    // Related cursor presented to search: rejected, foreign cursor untouched.
    const rFirst = await (
      await handleRelated(
        req(`http://x/api/v1/videos/${videoA}/related?limit=1`),
        videoA,
        relatedDeps,
      )
    ).json();
    expect(typeof rFirst.page.next).toBe("string");
    const back = await (
      await handleSearch(
        req(`http://x/api/v1/search?cursor=${rFirst.page.next}&limit=1`),
        searchDeps,
      )
    ).json();
    expect(back.data).toEqual([]);
    expect(back.page).toEqual({ next: null });
  });
});

describe("review: paginated cursor pages are private/no-store", () => {
  const relatedDeps = {
    fetchFirstPage: async (_id: string) =>
      fakeFeed([[vid("r1", "R1"), vid("r2", "R2")], [vid("r3", "R3")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };
  const commentsDeps = {
    fetchFirstPage: async (_id: string) =>
      fakeFeed([[thread("c1", "one"), thread("c2", "two")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };
  const exhaustedDeps = {
    fetchFirstPage: async (_id: string) => fakeFeed([[vid("only", "Only")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };
  const exhaustedCommentsDeps = {
    fetchFirstPage: async (_id: string) => fakeFeed([[thread("c1", "one")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };

  test("related page-1 with next != null -> private, no-store", async () => {
    const res = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=2"),
      "dQw4w9WgXcQ",
      relatedDeps,
    );
    const body = await res.json();
    expect(typeof body.page.next).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("related exhausted page (next == null) -> public s-maxage=600", async () => {
    const res = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=5"),
      "dQw4w9WgXcQ",
      exhaustedDeps,
    );
    const body = await res.json();
    expect(body.page.next).toBeNull();
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
  });

  test("related ?cursor= request -> private, no-store", async () => {
    const first = await (
      await handleRelated(
        req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=2"),
        "dQw4w9WgXcQ",
        relatedDeps,
      )
    ).json();
    const res = await handleRelated(
      req(
        `http://x/api/v1/videos/dQw4w9WgXcQ/related?cursor=${first.page.next}&limit=2`,
      ),
      "dQw4w9WgXcQ",
      relatedDeps,
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("comments page-1 with next != null -> private, no-store", async () => {
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=1"),
      "dQw4w9WgXcQ",
      commentsDeps,
    );
    const body = await res.json();
    expect(typeof body.page.next).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("comments exhausted page (next == null) -> public s-maxage=300", async () => {
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=5"),
      "dQw4w9WgXcQ",
      exhaustedCommentsDeps,
    );
    const body = await res.json();
    expect(body.page.next).toBeNull();
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
  });

  test("comments ?cursor= request -> private, no-store", async () => {
    const first = await (
      await handleComments(
        req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=1"),
        "dQw4w9WgXcQ",
        commentsDeps,
      )
    ).json();
    const res = await handleComments(
      req(
        `http://x/api/v1/videos/dQw4w9WgXcQ/comments?cursor=${first.page.next}&limit=1`,
      ),
      "dQw4w9WgXcQ",
      commentsDeps,
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
