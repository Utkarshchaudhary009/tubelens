import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleTranscript } from "../../app/api/v1/videos/[id]/transcript/route";
import { cacheGet, clearCache } from "../cache";
import {
  type FetchLike,
  fetchTranscriptFallback,
} from "../transcript-providers";

beforeEach(() => {
  clearCache();
});

function req(url: string, requestId = "transcript-fb"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

const segs = [
  { startSeconds: 0, durationSeconds: 2.5, text: "hello" },
  { startSeconds: 2.5, durationSeconds: 3, text: "world" },
];

function getTranscriptFailure(): Error {
  return Object.assign(
    new Error(
      "Request to https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false failed with status code 400",
    ),
    { name: "InnertubeError" },
  );
}

describe("transcript yttools fallback (mocked)", () => {
  test("fast-path failure + fallback success -> 200 + fallback_source warning", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript"),
      "dQw4w9WgXcQ",
      {
        fetchTranscript: async () => {
          throw getTranscriptFailure();
        },
        fetchFallback: async () => ({ segments: segs, provider: "yttools" }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("transcript-fb");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
    const body = await res.json();
    expect(body.data).toEqual(segs);
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("transcript-fb");
    expect(body.meta.lang).toBe("en");
    expect(body.meta.cached).toBe(false);
    expect(body.warnings).toContainEqual({
      code: "fallback_source",
      message: expect.stringContaining("yttools"),
    });
    // Successful fallback populates the lang-scoped cache entry.
    expect(cacheGet(`transcript:v1:dQw4w9WgXcQ:en`)).toBeDefined();
  });

  test("?lang= is passed to the fallback and keys the cache per language", async () => {
    const seen: Array<{ id: string; lang: string }> = [];
    const deps = {
      fetchTranscript: async () => {
        throw getTranscriptFailure();
      },
      fetchFallback: async (id: string, lang: string) => {
        seen.push({ id, lang });
        return { segments: segs, provider: "yttools" };
      },
    };
    const es = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript?lang=es"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(es.status).toBe(200);
    expect(await es.json().then((b) => b.meta.lang)).toBe("es");
    expect(seen).toEqual([{ id: "dQw4w9WgXcQ", lang: "es" }]);

    // A different lang is a cache miss -> fallback runs again.
    const en = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(en.status).toBe(200);
    expect(seen).toEqual([
      { id: "dQw4w9WgXcQ", lang: "es" },
      { id: "dQw4w9WgXcQ", lang: "en" },
    ]);

    // Same lang again is a cache hit -> fallback NOT re-run.
    const es2 = await handleTranscript(
      req("http://x/api/v1/videos/dQw4w9WgXcQ/transcript?lang=es"),
      "dQw4w9WgXcQ",
      deps,
    );
    expect(es2.status).toBe(200);
    expect(await es2.json().then((b) => b.meta.cached)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  test("fallback failure surfaces the fast-path 404, never a bare 500", async () => {
    const res = await handleTranscript(
      req("http://x/api/v1/videos/CCCCCCCCCCC/transcript"),
      "CCCCCCCCCCC",
      {
        fetchTranscript: async () => {
          throw getTranscriptFailure();
        },
        fetchFallback: async () => {
          throw new Error("yttools request failed with status 422");
        },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("transcript_unavailable");
    expect(typeof body.error.hint).toBe("string");
  });

  test("empty fallback falls through to the fast-path 404, never 200+[]", async () => {
    const id = "DDDDDDDDDDD";
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      {
        fetchTranscript: async () => {
          throw getTranscriptFailure();
        },
        fetchFallback: async () => ({ segments: [], provider: "yttools" }),
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("transcript_unavailable");
    expect(body.warnings ?? []).toEqual([]);
    expect(cacheGet(`transcript:v1:${id}:en`)).toBeUndefined();
  });

  test("cache hit preserves fallback_source (provider rides in cached value)", async () => {
    const id = "EEEEEEEEEEE";
    const url = `http://x/api/v1/videos/${id}/transcript`;
    const deps = {
      fetchTranscript: async () => {
        throw getTranscriptFailure();
      },
      fetchFallback: async () => ({ segments: segs, provider: "yttools" }),
    };
    const first = await handleTranscript(req(url), id, deps);
    expect(first.status).toBe(200);
    const b1 = await first.json();
    expect(b1.meta.cached).toBe(false);
    expect(b1.warnings).toContainEqual({
      code: "fallback_source",
      message: expect.stringContaining("yttools"),
    });

    // Hit path: upstream must not run, warning must survive.
    const second = await handleTranscript(req(url), id, {
      fetchTranscript: async () => {
        throw new Error("must not run on a cache hit");
      },
      fetchFallback: async () => {
        throw new Error("must not run on a cache hit");
      },
    });
    expect(second.status).toBe(200);
    const b2 = await second.json();
    expect(b2.meta.cached).toBe(true);
    expect(b2.data).toEqual(segs);
    expect(b2.warnings).toContainEqual({
      code: "fallback_source",
      message: expect.stringContaining("yttools"),
    });
  });

  test("video_not_found fast-path skips the fallback entirely", async () => {
    let fallbackCalls = 0;
    const res = await handleTranscript(
      req("http://x/api/v1/videos/AAAAAAAAAAA/transcript"),
      "AAAAAAAAAAA",
      {
        fetchTranscript: async () => {
          throw new Error("NOT_FOUND: video");
        },
        fetchFallback: async () => {
          fallbackCalls += 1;
          return { segments: segs, provider: "yttools" };
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("video_not_found");
    expect(fallbackCalls).toBe(0);
  });
});

describe("fetchTranscriptFallback (yttools, mocked fetch)", () => {
  function mockFetch(handler: (url: string) => unknown): FetchLike {
    return (async (input: string) => {
      const payload = handler(input);
      if (payload instanceof Error) {
        throw payload;
      }
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as FetchLike;
  }

  test("maps offset/duration ms -> seconds and passes url+lang", async () => {
    const urls: string[] = [];
    const fetchFn = mockFetch((url) => {
      urls.push(url);
      return {
        transcript: [
          { text: "hi", offset: 1500, duration: 2500, lang: "en" },
          { text: "there", offset: 4000, duration: 1000, lang: "en" },
        ],
      };
    });
    const result = await fetchTranscriptFallback("dQw4w9WgXcQ", "en", fetchFn);
    expect(result.provider).toBe("yttools");
    expect(result.segments).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "hi" },
      { startSeconds: 4, durationSeconds: 1, text: "there" },
    ]);
    expect(urls[0]).toContain("yttools.co/api/transcript");
    expect(urls[0]).toContain(encodeURIComponent("watch?v=dQw4w9WgXcQ"));
    expect(urls[0]).toContain("lang=en");
  });

  test("reported-language mismatch counts as failure", async () => {
    const fetchFn = mockFetch(() => ({
      transcript: [{ text: "hola", offset: 0, duration: 1000, lang: "es" }],
    }));
    await expect(
      fetchTranscriptFallback("dQw4w9WgXcQ", "en", fetchFn),
    ).rejects.toThrow(/language mismatch/);
  });

  test("mixed-language payload serves only the requested language", async () => {
    const fetchFn = mockFetch(() => ({
      transcript: [
        { text: "hello", offset: 0, duration: 1000, lang: "en" },
        { text: "hola", offset: 1000, duration: 1000, lang: "es" },
        { text: "untagged", offset: 2000, duration: 1000 },
      ],
    }));
    const result = await fetchTranscriptFallback("dQw4w9WgXcQ", "en", fetchFn);
    expect(result.segments.map((s) => s.text)).toEqual(["hello", "untagged"]);
  });

  test("non-object body throws a shape error, never a TypeError", async () => {
    for (const payload of [null, "oops", 42]) {
      const fetchFn = mockFetch(() => payload);
      await expect(
        fetchTranscriptFallback("dQw4w9WgXcQ", "en", fetchFn),
      ).rejects.toThrow(/unexpected response shape/);
    }
  });

  test("non-ok status and empty transcript throw", async () => {
    const bad: FetchLike = (async () => ({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => "",
    })) as FetchLike;
    await expect(
      fetchTranscriptFallback("dQw4w9WgXcQ", "en", bad),
    ).rejects.toThrow(/status 422/);
    const empty = mockFetch(() => ({ transcript: [] }));
    await expect(
      fetchTranscriptFallback("dQw4w9WgXcQ", "en", empty),
    ).rejects.toThrow(/no transcript segments/);
  });
});
