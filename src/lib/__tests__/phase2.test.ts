import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { handleCaptions } from "../../app/api/v1/videos/[id]/captions/route";
import { handleComments } from "../../app/api/v1/videos/[id]/comments/route";
import { handleRelated } from "../../app/api/v1/videos/[id]/related/route";
import { handleTranscript } from "../../app/api/v1/videos/[id]/transcript/route";
import { cacheSet, clearCache } from "../cache";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import {
  classifyCaptionsError,
  classifyTranscriptError,
  mapCaptionTrack,
  mapComment,
  mapRelatedItem,
  mapTranscriptSegment,
} from "../mappers";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

function req(url: string, requestId = "phase2"): NextRequest {
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
const thread = (
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "CommentThread",
  comment: {
    comment_id: id,
    content: { text },
    author: { id: `author-${id}`, name: `Author ${id}` },
    like_count: "12",
    published_time: "2 days ago",
    reply_count: "3",
    is_pinned: false,
    ...extra,
  },
});

describe("related handler (mocked upstream)", () => {
  const deps = {
    fetchFirstPage: async (_id: string) =>
      fakeFeed([[vid("r1", "R1"), vid("r2", "R2")], [vid("r3", "R3")]]),
    continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let called = false;
    const res = await handleRelated(
      req("http://x/api/v1/videos/!!!/related"),
      "!!!",
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
    const body = await res.json();
    expect(body.error.code).toBe("invalid_video_id");
    expect(typeof body.error.hint).toBe("string");
    expect(called).toBe(false);
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=many"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("unknown cursor -> [] + next: null (never 404)", async () => {
    const res = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?cursor=nope"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("first page maps DTOs, mints cursor; cursor walks page 2", async () => {
    const first = await handleRelated(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=2"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(first.status).toBe(200);
    const b1 = await first.json();
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual(["r1", "r2"]);
    expect(b1.data[0].kind).toBe("video");
    expect(typeof b1.page.next).toBe("string");
    expect(b1.meta.requestId).toBe("phase2");
    expect(first.headers.get("X-Request-Id")).toBe("phase2");
    // Page carries a process-local cursor -> private/no-store, never CDN.
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");

    const second = await handleRelated(
      req(
        `http://x/api/v1/videos/dQw4w9WgXcQ/related?cursor=${b1.page.next}&limit=2`,
      ),
      "dQw4w9WgXcQ",
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["r3"]);
    expect(b2.page.next).toBeNull();
  });

  test("two identical queries get independent cursors (no shared mutation)", async () => {
    const url = "http://x/api/v1/videos/dQw4w9WgXcQ/related?limit=1";
    const b1 = await (
      await handleRelated(req(url), "dQw4w9WgXcQ", deps)
    ).json();
    const b2 = await (
      await handleRelated(req(url), "dQw4w9WgXcQ", deps)
    ).json();
    expect(b2.meta.cached).toBe(true);
    expect(b2.page.next).not.toBe(b1.page.next);
    const w1 = await (
      await handleRelated(
        req(
          `http://x/api/v1/videos/dQw4w9WgXcQ/related?cursor=${b1.page.next}&limit=1`,
        ),
        "dQw4w9WgXcQ",
        deps,
      )
    ).json();
    const w2 = await (
      await handleRelated(
        req(
          `http://x/api/v1/videos/dQw4w9WgXcQ/related?cursor=${b2.page.next}&limit=1`,
        ),
        "dQw4w9WgXcQ",
        deps,
      )
    ).json();
    expect(w1.data.map((d: { id: string }) => d.id)).toEqual(["r2"]);
    expect(w2.data.map((d: { id: string }) => d.id)).toEqual(["r2"]);
  });

  test("NOT_FOUND -> 404 video_not_found; timeout -> 504", async () => {
    const nf = await handleRelated(
      req("http://x/api/v1/videos/AAAAAAAAAAA/related"),
      "AAAAAAAAAAA",
      {
        fetchFirstPage: async () => {
          throw new Error("NOT_FOUND: video");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("video_not_found");

    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handleRelated(
      req("http://x/api/v1/videos/BBBBBBBBBBB/related"),
      "BBBBBBBBBBB",
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
});

describe("comments handler (mocked upstream)", () => {
  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let called = false;
    const res = await handleComments(
      req("http://x/api/v1/videos/!!!/comments"),
      "!!!",
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
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(called).toBe(false);
  });

  test("unknown cursor -> [] + next: null (never 404)", async () => {
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?cursor=nope"),
      "dQw4w9WgXcQ",
      {
        fetchFirstPage: async () => fakeFeed([[thread("c1", "hi")]]),
        continueFeed: async (p) => p.getContinuation(),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("walks >= 5 pages without dupes or drops", async () => {
    const pages = Array.from({ length: 6 }, (_, p) => [
      thread(`c${p * 2 + 1}`, `comment ${p * 2 + 1}`),
      thread(`c${p * 2 + 2}`, `comment ${p * 2 + 2}`),
    ]);
    const deps = {
      fetchFirstPage: async (_id: string) => fakeFeed(pages),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const seen: string[] = [];
    let cursor: string | null = null;
    let fetches = 0;
    // Page 1 comes from the id route; pages 2..6 via cursors.
    const first = await (
      await handleComments(
        req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=2"),
        "dQw4w9WgXcQ",
        deps,
      )
    ).json();
    fetches += 1;
    for (const c of first.data as Array<{ id: string }>) {
      seen.push(c.id);
    }
    cursor = first.page.next;
    while (cursor) {
      fetches += 1;
      const body = await (
        await handleComments(
          req(
            `http://x/api/v1/videos/dQw4w9WgXcQ/comments?cursor=${cursor}&limit=2`,
          ),
          "dQw4w9WgXcQ",
          deps,
        )
      ).json();
      for (const c of body.data as Array<{ id: string }>) {
        seen.push(c.id);
      }
      cursor = body.page.next;
      if (fetches > 10) {
        throw new Error("pagination did not terminate");
      }
    }
    expect(fetches).toBe(6);
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `c${i + 1}`));
    expect(new Set(seen).size).toBe(12);
  });

  test("comment DTO shape + Cache-Control + tracing headers", async () => {
    const deps = {
      fetchFirstPage: async (_id: string) =>
        fakeFeed([[thread("c9", "hello", { is_pinned: true })]]),
      continueFeed: async (p: ContinuationSearch) => p.getContinuation(),
    };
    const res = await handleComments(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/comments?limit=5"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(res.headers.get("X-Request-Id")).toBe("phase2");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: "c9",
      author: { id: "author-c9", name: "Author c9" },
      text: "hello",
      likeCount: 12,
      publishedText: "2 days ago",
      replyCount: 3,
      isPinned: true,
    });
    expect(body.meta.requestId).toBe("phase2");
  });

  test("isPinned requires an explicit true (outer false never pins)", () => {
    const bare = (outer: Record<string, unknown>) => ({
      type: "CommentThread",
      ...outer,
      comment: { comment_id: "c1", content: { text: "hi" } },
    });
    // Outer explicitly not pinned + nested omits the field -> unset.
    expect(mapComment(bare({ is_pinned: false }))?.isPinned).toBeUndefined();
    // Outer explicitly pinned + nested omits the field -> pinned.
    expect(mapComment(bare({ is_pinned: true }))?.isPinned).toBe(true);
    // Nested explicit false wins over an outer true.
    expect(
      mapComment({
        type: "CommentThread",
        is_pinned: true,
        comment: {
          comment_id: "c1",
          content: { text: "hi" },
          is_pinned: false,
        },
      })?.isPinned,
    ).toBe(false);
  });
});

describe("captions handler (mocked upstream)", () => {
  const tracks = [
    { languageCode: "en", name: "English", kind: "manual" as const },
    { languageCode: "es", name: "Spanish (auto)", kind: "auto" as const },
  ];

  test("invalid id -> 400 invalid_video_id", async () => {
    const res = await handleCaptions(
      req("http://x/api/v1/videos/!!/captions"),
      "!!",
      {
        fetchCaptions: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
  });

  test("track list served with aggressive-static Cache-Control", async () => {
    const res = await handleCaptions(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/captions"),
      "dQw4w9WgXcQ",
      { fetchCaptions: async () => tracks },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
    const body = await res.json();
    expect(body.data).toEqual(tracks);
    expect(body.page).toEqual({ next: null });
    expect(body.meta.cached).toBe(false);
  });

  test("no tracks -> 404 captions_disabled with actionable hint", async () => {
    const res = await handleCaptions(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/captions"),
      "dQw4w9WgXcQ",
      { fetchCaptions: async () => [] },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("captions_disabled");
    expect(typeof body.error.hint).toBe("string");
    expect(body.error.hint.length).toBeGreaterThan(10);
  });

  test("stale-on-error: upstream 403 with stale copy -> 200 + stale_served", async () => {
    const id = "dQw4w9WgXcQ";
    const url = `http://x/api/v1/videos/${id}/captions`;
    const primed = await (
      await handleCaptions(req(url), id, { fetchCaptions: async () => tracks })
    ).json();
    // Age the L0 entry past its fresh window so the next fetch failure
    // serves stale instead of throwing.
    cacheSet(`captions:v1:${id}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleCaptions(req(url), id, {
      fetchCaptions: async () => {
        throw new Error("403 Forbidden");
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(tracks);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("cold-miss failure -> typed error with hint, never bare 500", async () => {
    const res = await handleCaptions(
      req("http://x/api/v1/videos/CCCCCCCCCCC/captions"),
      "CCCCCCCCCCC",
      {
        fetchCaptions: async () => {
          throw new Error("500 Internal Server Error");
        },
      },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
  });
});

describe("transcript handler (mocked upstream)", () => {
  const segments = [
    { startSeconds: 0, durationSeconds: 2.5, text: "hello" },
    { startSeconds: 2.5, durationSeconds: 3, text: "world" },
  ];

  test("invalid id -> 400 invalid_video_id", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/!!/transcript"),
      "!!",
      {
        fetchTranscript: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
  });

  test("segments served in one page with aggressive Cache-Control", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript"),
      "dQw4w9WgXcQ",
      { fetchTranscript: async () => segments },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
    const body = await res.json();
    expect(body.data).toEqual(segments);
    expect(body.page).toEqual({ next: null });
  });

  test("engagement-panel throw -> 404 transcript_unavailable with hint", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript"),
      "dQw4w9WgXcQ",
      {
        fetchTranscript: async () => {
          throw new Error(
            "Engagement panels not found. Video likely has no transcript.",
          );
        },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("transcript_unavailable");
    expect(body.error.hint).toMatch(/hide the transcript panel/i);
  });

  test("stale-on-error: upstream 429 with stale copy -> 200 + stale_served", async () => {
    const id = "dQw4w9WgXcQ";
    const url = `http://x/api/v1/videos/${id}/transcript`;
    const primed = await (
      await handleTranscript(req(url), id, {
        fetchTranscript: async () => segments,
      })
    ).json();
    cacheSet(`transcript:v1:${id}:en`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleTranscript(req(url), id, {
      fetchTranscript: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(segments);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("cold-miss failure -> typed error with hint, never bare 500", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/CCCCCCCCCCC/transcript"),
      "CCCCCCCCCCC",
      {
        fetchTranscript: async () => {
          throw new Error("Transcript continuation not found.");
        },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("transcript_unavailable");
    expect(typeof body.error.hint).toBe("string");
  });
});

describe("phase 2 mappers", () => {
  test("mapRelatedItem: CompactVideo gains viewText", () => {
    const dto = mapRelatedItem({
      type: "CompactVideo",
      video_id: "abc123DEF45",
      title: { text: "Up next" },
      author: { id: "UCx", name: "Chan" },
      view_count: { text: "1.2M views" },
      published: { text: "1 week ago" },
      length_text: { text: "10:00" },
    });
    expect(dto).toMatchObject({
      id: "abc123DEF45",
      kind: "video",
      title: "Up next",
      viewText: "1.2M views",
      publishedText: "1 week ago",
    });
  });

  test("mapRelatedItem: LockupView maps via content_id/type", () => {
    const dto = mapRelatedItem({
      type: "LockupView",
      content_id: "xyz987ABC12",
      content_type: "VIDEO",
      metadata: { title: { text: "Locked" } },
    });
    expect(dto).toMatchObject({
      id: "xyz987ABC12",
      kind: "video",
      title: "Locked",
    });
  });

  test("mapRelatedItem: unknown node -> null", () => {
    expect(mapRelatedItem({ type: "AdBanner", id: "x" })).toBeNull();
    expect(mapRelatedItem(null)).toBeNull();
  });

  test("mapComment: thread maps fully; bare view also works", () => {
    expect(mapComment(thread("c1", "hi"))).toMatchObject({
      id: "c1",
      text: "hi",
      likeCount: 12,
      replyCount: 3,
    });
    expect(
      mapComment({
        comment_id: "bare",
        content: "yo",
        author: { name: "A" },
      })?.id,
    ).toBe("bare");
    expect(mapComment({ type: "CommentThread" })).toBeNull();
  });

  test("mapCaptionTrack: asr -> auto, missing kind -> manual", () => {
    expect(
      mapCaptionTrack({
        language_code: "en",
        name: { text: "English" },
        kind: "asr",
        is_translatable: true,
      }),
    ).toMatchObject({ languageCode: "en", kind: "auto" });
    expect(
      mapCaptionTrack({ language_code: "fr", name: "French" }),
    ).toMatchObject({ languageCode: "fr", kind: "manual" });
    expect(mapCaptionTrack({ name: "NoLang" })).toBeNull();
  });

  test("mapTranscriptSegment: ms -> seconds, empty text dropped", () => {
    expect(
      mapTranscriptSegment({
        start_ms: "1500",
        end_ms: "4000",
        snippet: { text: "hi" },
      }),
    ).toMatchObject({ startSeconds: 1.5, durationSeconds: 2.5, text: "hi" });
    expect(
      mapTranscriptSegment({ start_ms: "0", snippet: { text: "  " } }),
    ).toBeNull();
    expect(mapTranscriptSegment({ snippet: { text: "no start" } })).toBeNull();
  });

  test("classifyCaptionsError / classifyTranscriptError", () => {
    expect(classifyCaptionsError(new Error("captions disabled"))).toMatchObject(
      { code: "captions_disabled", status: 404 },
    );
    expect(
      classifyTranscriptError(
        new Error(
          "Transcript panel not found. Video likely has no transcript.",
        ),
      ),
    ).toMatchObject({ code: "transcript_unavailable", status: 404 });
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(classifyTranscriptError(timeout).status).toBe(504);
  });
});

describe("openapi phase 2", () => {
  test("lists the 4 new watch-essentials paths with params", () => {
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
    for (const p of [
      "/videos/{id}/related",
      "/videos/{id}/comments",
      "/videos/{id}/captions",
      "/videos/{id}/transcript",
    ]) {
      expect(Object.keys(paths)).toContain(p);
      const params = paths[p].get.parameters.map((q) => q.name);
      expect(params).toContain("id");
    }
    const relatedParams = paths["/videos/{id}/related"].get.parameters.map(
      (q) => q.name,
    );
    expect(relatedParams).toEqual(
      expect.arrayContaining(["limit", "cursor", "region", "lang"]),
    );
    for (const p of [
      "/videos/{id}/related",
      "/videos/{id}/comments",
      "/videos/{id}/captions",
      "/videos/{id}/transcript",
    ]) {
      const codes = Object.keys(paths[p].get.responses);
      for (const c of ["200", "400", "404", "429", "502", "504"]) {
        expect(codes).toContain(c);
      }
    }
  });
});
