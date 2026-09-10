import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { cacheSet, clearCache } from "../cache";
import {
  COMMUNITY_STALE_MS,
  type CombinedDeps,
  classifyCommunityError,
  type DeArrowDeps,
  type DislikesDeps,
  dearrowCacheKey,
  dislikesCacheKey,
  fetchDeArrowUpstream,
  fetchDislikesUpstream,
  fetchSponsorsUpstream,
  handleCombined,
  handleDeArrow,
  handleDislikes,
  handleSponsors,
  mapDeArrowResponse,
  mapDislikesResponse,
  mapSponsorSegments,
  SPONSOR_CATEGORIES,
  type SponsorsDeps,
  sponsorsCacheKey,
} from "../community";
import type { VideoDetailsDTO } from "../mappers";

beforeEach(() => {
  clearCache();
});

function req(url: string, requestId = "phase8"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

const VID = "dQw4w9WgXcQ";

const sponsorsFixture = [
  { segment: [12.5, 45.0], category: "sponsor", actionType: "skip" },
  { segment: [0, 8.25], category: "intro", actionType: "skip" },
];

const dislikesFixture = {
  id: VID,
  dateCreated: "2021-01-01T00:00:00.000Z",
  likes: 1000,
  dislikes: 50,
  rating: 4.8,
  viewCount: 20000,
  deleted: false,
};

const dearrowFixture = {
  titles: [
    { title: "Original Title", votes: 100, original: true },
    { title: "Better Crowd Title", votes: 42, original: false },
    { title: "Worse Crowd Title", votes: 3, original: false },
  ],
  thumbnails: [
    { timestamp: 12.5, votes: 9, original: false },
    { timestamp: 30, votes: 2, original: false },
    { timestamp: 0, votes: 50, original: true },
  ],
};

const videoFixture: VideoDetailsDTO = {
  id: VID,
  title: "Some Video",
  channel: { id: "UC_x5XG1OV2P6uZZ5FSM9Ttw", name: "Some Channel" },
};

function timeoutErr(): Error {
  const err = new Error("Upstream timed out after 8000ms");
  err.name = "TimeoutError";
  return err;
}

function notFoundErr(): Error {
  return Object.assign(new Error("NOT_FOUND: video unavailable"), {
    name: "InnertubeError",
  });
}

describe("phase 8 community mappers", () => {
  test("sponsor categories are the six documented skip categories", () => {
    expect([...SPONSOR_CATEGORIES]).toEqual([
      "sponsor",
      "intro",
      "outro",
      "interaction",
      "selfpromo",
      "music_offtopic",
    ]);
  });

  test("mapSponsorSegments maps start/end/category, drops malformed rows", () => {
    expect(mapSponsorSegments(sponsorsFixture)).toEqual([
      { start: 12.5, end: 45, category: "sponsor" },
      { start: 0, end: 8.25, category: "intro" },
    ]);
    expect(
      mapSponsorSegments([
        { segment: [10, 5], category: "sponsor" },
        { segment: ["x", 5], category: "sponsor" },
        { nope: true },
        null,
        ...sponsorsFixture,
      ]),
    ).toHaveLength(2);
    expect(mapSponsorSegments({})).toEqual([]);
  });

  test("mapDislikesResponse maps fields 1:1, null on unusable payload", () => {
    expect(mapDislikesResponse(dislikesFixture, VID)).toEqual(dislikesFixture);
    expect(mapDislikesResponse(null, VID)).toBeNull();
    expect(mapDislikesResponse({ id: VID }, VID)).toBeNull();
  });

  test("mapDeArrowResponse picks the top-voted non-original title", () => {
    const dto = mapDeArrowResponse(dearrowFixture, VID);
    expect(dto?.title).toBe("Better Crowd Title");
    expect(dto?.thumbnails).toHaveLength(2);
    expect(dto?.thumbnails[0]).toMatchObject({ timestamp: 12.5 });
    expect(dto?.thumbnails[0]?.url).toContain(`videoID=${VID}&time=12.5`);
    expect(dto?.thumbnails[0]?.url).toContain("dearrow-thumb.ajay.app");
  });

  test("mapDeArrowResponse is null when only originals (or nothing) exist", () => {
    expect(
      mapDeArrowResponse(
        {
          titles: [{ title: "Original", votes: 10, original: true }],
          thumbnails: [{ timestamp: 1, votes: 5, original: true }],
        },
        VID,
      ),
    ).toBeNull();
    expect(mapDeArrowResponse({ titles: [], thumbnails: [] }, VID)).toBeNull();
    expect(mapDeArrowResponse(null, VID)).toBeNull();
  });

  test("branding rows omitting original never override title/thumbnail", () => {
    expect(
      mapDeArrowResponse(
        {
          titles: [
            { title: "Original Title", votes: 1, original: true },
            { title: "Sneaky Title", votes: 999 },
            { title: "Crowd Title", votes: 5, original: false },
          ],
          thumbnails: [
            { timestamp: 3, votes: 999 },
            { timestamp: 12.5, votes: 4, original: false },
          ],
        },
        VID,
      ),
    ).toEqual({
      title: "Crowd Title",
      thumbnails: [
        {
          timestamp: 12.5,
          url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${VID}&time=12.5`,
        },
      ],
    });
    // Rows omitting original alone mean no usable crowd data.
    expect(
      mapDeArrowResponse(
        {
          titles: [{ title: "Sneaky Title", votes: 999 }],
          thumbnails: [{ timestamp: 3, votes: 999 }],
        },
        VID,
      ),
    ).toBeNull();
  });

  test("error classifier: timeout is 504, generic failure is 502", () => {
    for (const source of ["sponsors", "dislikes", "dearrow"] as const) {
      expect(classifyCommunityError(source, timeoutErr()).status).toBe(504);
      expect(classifyCommunityError(source, timeoutErr()).code).toBe(
        "upstream_timeout",
      );
      const down = classifyCommunityError(source, new Error("socket hang up"));
      expect(down.status).toBe(502);
      expect(down.code).toBe("upstream_degraded");
      expect(typeof down.hint).toBe("string");
    }
  });
});

describe("phase 8 third-party fetch shape", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = origFetch;
  });

  test("sponsors fetch hits skipSegments with categories + actionType, 404 -> []", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(fetchSponsorsUpstream(VID)).resolves.toEqual([]);
    expect(seenUrl).toContain(`videoID=${VID}`);
    expect(seenUrl).toContain("actionType=skip");
    const cats = new URL(seenUrl).searchParams.get("categories") ?? "";
    expect(JSON.parse(cats)).toEqual([...SPONSOR_CATEGORIES]);
  });

  test("dislikes fetch uses lowercase videoId param, 404 -> null", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify(dislikesFixture), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchDislikesUpstream(VID)).resolves.toEqual(dislikesFixture);
    expect(new URL(seenUrl).searchParams.get("videoId")).toBe(VID);

    globalThis.fetch = (async () =>
      new Response("No stats", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDislikesUpstream(VID)).resolves.toBeNull();
  });

  test("dearrow fetch hits branding, 404 -> null", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify(dearrowFixture), { status: 200 });
    }) as unknown as typeof fetch;
    const dto = await fetchDeArrowUpstream(VID);
    expect(dto?.title).toBe("Better Crowd Title");
    expect(seenUrl).toContain(`videoID=${VID}`);

    globalThis.fetch = (async () =>
      new Response("No branding", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDeArrowUpstream(VID)).resolves.toBeNull();
  });

  test("third-party fetches fail fast with an 8s abort signal", async () => {
    let seenSignal: AbortSignal | null = null;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenSignal = (init?.signal as AbortSignal) ?? null;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSponsorsUpstream(VID);
    expect(seenSignal).not.toBeNull();
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(false);
  });

  test("429 responses carry status + Retry-After for the classifier", async () => {
    globalThis.fetch = (async () =>
      new Response("Slow down", {
        status: 429,
        headers: { "Retry-After": "7" },
      })) as unknown as typeof fetch;
    const err = await fetchSponsorsUpstream(VID).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect((err as { status: number }).status).toBe(429);
    expect(classifyCommunityError("sponsors", err)).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfter: 7,
    });
  });

  test("429 without Retry-After falls back to the 60s default", async () => {
    globalThis.fetch = (async () =>
      new Response("Slow down", { status: 429 })) as unknown as typeof fetch;
    const err = await fetchSponsorsUpstream(VID).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { status: number }).status).toBe(429);
    expect(err as object).not.toHaveProperty("retryAfter");
    expect(classifyCommunityError("sponsors", err)).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfter: 60,
    });
  });

  test("malformed upstream JSON is a typed 502, never a 500", async () => {
    globalThis.fetch = (async () =>
      new Response("not json{{{", { status: 200 })) as unknown as typeof fetch;
    const res = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      { fetchSponsors: (id) => fetchSponsorsUpstream(id) },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
  });
});

describe("sponsors route", () => {
  const deps: SponsorsDeps = {
    fetchSponsors: async () => mapSponsorSegments(sponsorsFixture),
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let calls = 0;
    const res = await handleSponsors(req("http://x/sponsors"), "bad id!!", {
      fetchSponsors: async () => {
        calls += 1;
        return [];
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(calls).toBe(0);
  });

  test("success carries the envelope, echo, and third-party TTL", async () => {
    const res = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors?region=de&lang=fr`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { start: 12.5, end: 45, category: "sponsor" },
      { start: 0, end: 8.25, category: "intro" },
    ]);
    expect(body.page).toEqual({ next: null });
    expect(body.meta).toMatchObject({
      region: "DE",
      lang: "fr",
      cached: false,
      requestId: "phase8",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("x-request-id")).toBe("phase8");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate=21600");
  });

  test("unknown video with no segments is data:[], never 404", async () => {
    const res = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      { fetchSponsors: async () => [] },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  test("repeat call serves L0 with cached:true", async () => {
    const url = `http://x/api/v1/videos/${VID}/sponsors`;
    const first = await handleSponsors(req(url), VID, deps);
    expect((await first.json()).meta.cached).toBe(false);
    const second = await handleSponsors(req(url), VID, {
      fetchSponsors: async () => {
        throw new Error("must not run on a fresh hit");
      },
    });
    const body = await second.json();
    expect(body.meta.cached).toBe(true);
    expect(body.warnings).toEqual([]);
  });

  test("stale-on-error serves cached segments with cached:true + warnings", async () => {
    const primed = await (
      await handleSponsors(
        req(`http://x/api/v1/videos/${VID}/sponsors`),
        VID,
        deps,
      )
    ).json();
    cacheSet(sponsorsCacheKey(VID), primed.data, -1, COMMUNITY_STALE_MS);
    const stale = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      {
        fetchSponsors: async () => {
          throw timeoutErr();
        },
      },
    );
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("cold-miss timeout is 504, generic failure is 502", async () => {
    const to = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      {
        fetchSponsors: async () => {
          throw timeoutErr();
        },
      },
    );
    expect(to.status).toBe(504);
    const toBody = await to.json();
    expect(toBody.error.code).toBe("upstream_timeout");
    expect(typeof toBody.error.hint).toBe("string");

    const down = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      {
        fetchSponsors: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(down.status).toBe(502);
    expect((await down.json()).error.code).toBe("upstream_degraded");
  });
});

describe("dislikes route", () => {
  const deps: DislikesDeps = {
    fetchDislikes: async () => mapDislikesResponse(dislikesFixture, VID),
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let calls = 0;
    const res = await handleDislikes(req("http://x/dislikes"), "!!!", {
      fetchDislikes: async () => {
        calls += 1;
        return null;
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(calls).toBe(0);
  });

  test("success carries mapped stats, echo, and third-party TTL", async () => {
    const res = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes?region=gb&lang=de`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(dislikesFixture);
    expect(body.page).toEqual({ next: null });
    expect(body.meta).toMatchObject({
      region: "GB",
      lang: "de",
      cached: false,
      requestId: "phase8",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("cache-control") ?? "").toContain("s-maxage=3600");
  });

  test("missing crowd data is data:null + warning, never 404", async () => {
    const res = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes`),
      VID,
      { fetchDislikes: async () => null },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.warnings[0].code).toBe("dislikes_unavailable");
  });

  test("stale-on-error serves cached stats with cached:true + warnings", async () => {
    const primed = await (
      await handleDislikes(
        req(`http://x/api/v1/videos/${VID}/dislikes`),
        VID,
        deps,
      )
    ).json();
    cacheSet(dislikesCacheKey(VID), primed.data, -1, COMMUNITY_STALE_MS);
    const stale = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes`),
      VID,
      {
        fetchDislikes: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("cold-miss failure is a typed 502 with a hint", async () => {
    const res = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes`),
      VID,
      {
        fetchDislikes: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
  });

  test("upstream 429 is a 429 rate_limited with a Retry-After header", async () => {
    const res = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes`),
      VID,
      {
        fetchDislikes: async () => {
          throw Object.assign(
            new Error(
              "ReturnYouTubeDislike upstream responded with status 429",
            ),
            { name: "UpstreamError", status: 429, retryAfter: 7 },
          );
        },
      },
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
    expect(typeof body.error.hint).toBe("string");
    expect(res.headers.get("Retry-After")).toBe("7");
  });

  test("upstream 429 without Retry-After defaults to Retry-After: 60", async () => {
    const res = await handleDislikes(
      req(`http://x/api/v1/videos/${VID}/dislikes`),
      VID,
      {
        fetchDislikes: async () => {
          throw Object.assign(
            new Error(
              "ReturnYouTubeDislike upstream responded with status 429",
            ),
            { name: "UpstreamError", status: 429 },
          );
        },
      },
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("dearrow route", () => {
  const deps: DeArrowDeps = {
    fetchDeArrow: async () => mapDeArrowResponse(dearrowFixture, VID),
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let calls = 0;
    const res = await handleDeArrow(req("http://x/dearrow"), "!!!", {
      fetchDeArrow: async () => {
        calls += 1;
        return null;
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(calls).toBe(0);
  });

  test("success carries crowd title + thumbnails and third-party TTL", async () => {
    const res = await handleDeArrow(
      req(`http://x/api/v1/videos/${VID}/dearrow`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("Better Crowd Title");
    expect(body.data.thumbnails).toHaveLength(2);
    expect(body.page).toEqual({ next: null });
    expect(body.meta.cached).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("cache-control") ?? "").toContain("s-maxage=3600");
  });

  test("missing crowd data is data:null + warning, never 404", async () => {
    const res = await handleDeArrow(
      req(`http://x/api/v1/videos/${VID}/dearrow`),
      VID,
      { fetchDeArrow: async () => null },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.warnings[0].code).toBe("dearrow_unavailable");
  });

  test("stale-on-error serves cached branding with cached:true + warnings", async () => {
    const primed = await (
      await handleDeArrow(
        req(`http://x/api/v1/videos/${VID}/dearrow`),
        VID,
        deps,
      )
    ).json();
    cacheSet(dearrowCacheKey(VID), primed.data, -1, COMMUNITY_STALE_MS);
    const stale = await handleDeArrow(
      req(`http://x/api/v1/videos/${VID}/dearrow`),
      VID,
      {
        fetchDeArrow: async () => {
          throw timeoutErr();
        },
      },
    );
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("cold-miss failure is a typed 502 with a hint", async () => {
    const res = await handleDeArrow(
      req(`http://x/api/v1/videos/${VID}/dearrow`),
      VID,
      {
        fetchDeArrow: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_degraded");
  });
});

describe("combined route", () => {
  const fullDeps: CombinedDeps = {
    fetchVideo: async () => videoFixture,
    fetchSponsors: async () => mapSponsorSegments(sponsorsFixture),
    fetchDislikes: async () => mapDislikesResponse(dislikesFixture, VID),
    fetchDeArrow: async () => mapDeArrowResponse(dearrowFixture, VID),
  };

  test("invalid id -> 400 invalid_video_id, upstream untouched", async () => {
    let calls = 0;
    const counting: CombinedDeps = {
      fetchVideo: async () => {
        calls += 1;
        return videoFixture;
      },
      fetchSponsors: async () => {
        calls += 1;
        return [];
      },
      fetchDislikes: async () => {
        calls += 1;
        return null;
      },
      fetchDeArrow: async () => {
        calls += 1;
        return null;
      },
    };
    const res = await handleCombined(req("http://x/combined"), "!!!", counting);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(calls).toBe(0);
  });

  test("all parts healthy compose with no warnings and the combined TTL", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined?region=de&lang=fr`),
      VID,
      fullDeps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.video).toEqual(videoFixture);
    expect(body.data.sponsors).toHaveLength(2);
    expect(body.data.dislikes).toEqual(dislikesFixture);
    expect(body.data.title ?? body.data.dearrow?.title).toBe(
      "Better Crowd Title",
    );
    expect(body.page).toEqual({ next: null });
    expect(body.meta).toMatchObject({
      region: "DE",
      lang: "fr",
      cached: false,
      requestId: "phase8",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("x-request-id")).toBe("phase8");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate=21600");
  });

  test("one source down still returns 200 with partial data + warnings", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        ...fullDeps,
        fetchSponsors: async () => {
          throw new Error("SponsorBlock down");
        },
        fetchDeArrow: async () => null,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.video).toEqual(videoFixture);
    expect(body.data.sponsors).toEqual([]);
    expect(body.data.dislikes).toEqual(dislikesFixture);
    expect(body.data.dearrow).toBeNull();
    const codes = body.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain("sponsors_unavailable");
    expect(codes).toContain("dearrow_unavailable");
    expect(codes).not.toContain("video_unavailable");
    expect(codes).not.toContain("dislikes_unavailable");
  });

  test("video detail failure degrades to null, still HTTP 200", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        ...fullDeps,
        fetchVideo: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.video).toBeNull();
    expect(body.data.sponsors).toHaveLength(2);
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain(
      "video_unavailable",
    );
  });

  test("definitive video_not_found is a 404 like GET /videos/:id", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        ...fullDeps,
        fetchVideo: async () => {
          throw notFoundErr();
        },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("video_not_found");
    expect(typeof body.error.hint).toBe("string");
    expect(body.meta.requestId).toBe("phase8");
    expect(res.headers.get("x-request-id")).toBe("phase8");
  });

  test("video_not_found never serves stale (definitive errors bypass cache)", async () => {
    const primed = await (
      await handleCombined(
        req(`http://x/api/v1/videos/${VID}/combined`),
        VID,
        fullDeps,
      )
    ).json();
    // Expire the video entry into its stale window: a transient failure
    // would serve this copy, but a definitive not-found must still 404.
    cacheSet(`video:v1:${VID}`, primed.data.video, -1, 60 * 60 * 1000);
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        ...fullDeps,
        fetchVideo: async () => {
          throw notFoundErr();
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("video_not_found");
  });

  test("Phase 8 responses carry X-RateLimit-* headers", async () => {
    const res = await handleSponsors(
      req(`http://x/api/v1/videos/${VID}/sponsors`),
      VID,
      { fetchSponsors: async () => [] },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  test("a timed-out part warns instead of failing the whole response", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        ...fullDeps,
        fetchDislikes: async () => {
          throw timeoutErr();
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dislikes).toBeNull();
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain(
      "dislikes_unavailable",
    );
  });

  test("everything down still returns 200 with nulls/[] and four warnings", async () => {
    const res = await handleCombined(
      req(`http://x/api/v1/videos/${VID}/combined`),
      VID,
      {
        fetchVideo: async () => {
          throw new Error("innertube down");
        },
        fetchSponsors: async () => {
          throw new Error("sponsorblock down");
        },
        fetchDislikes: async () => {
          throw new Error("ryd down");
        },
        fetchDeArrow: async () => {
          throw new Error("dearrow down");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      video: null,
      sponsors: [],
      dislikes: null,
      dearrow: null,
    });
    const codes = body.warnings.map((w: { code: string }) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "video_unavailable",
        "sponsors_unavailable",
        "dislikes_unavailable",
        "dearrow_unavailable",
      ]),
    );
  });

  test("combined reuses the singles cache keys (warm singles warm combined)", async () => {
    const url = `http://x/api/v1/videos/${VID}/combined`;
    const first = await handleCombined(req(url), VID, fullDeps);
    expect((await first.json()).meta.cached).toBe(false);
    // All four parts now cached: a fully-failing deps object still serves.
    const second = await handleCombined(req(url), VID, {
      fetchVideo: async () => {
        throw new Error("must not run on a fresh hit");
      },
      fetchSponsors: async () => {
        throw new Error("must not run on a fresh hit");
      },
      fetchDislikes: async () => {
        throw new Error("must not run on a fresh hit");
      },
      fetchDeArrow: async () => {
        throw new Error("must not run on a fresh hit");
      },
    });
    const body = await second.json();
    expect(body.meta.cached).toBe(true);
    expect(body.data.video).toEqual(videoFixture);
    expect(body.data.dislikes).toEqual(dislikesFixture);
    expect(body.warnings).toEqual([]);
  });
});

describe("openapi lists the phase 8 community routes", () => {
  test("all four community paths are documented with params", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        {
          get: {
            operationId: string;
            parameters: Array<{ name: string }>;
            responses: Record<string, unknown>;
          };
        }
      >;
    };
    const expected: Record<string, string> = {
      "/videos/{id}/sponsors": "getSponsors",
      "/videos/{id}/dislikes": "getDislikes",
      "/videos/{id}/dearrow": "getDeArrow",
      "/videos/{id}/combined": "getCombinedVideo",
    };
    for (const [path, operationId] of Object.entries(expected)) {
      expect(doc.paths[path]).toBeDefined();
      expect(doc.paths[path].get.operationId).toBe(operationId);
      const params = doc.paths[path].get.parameters.map((p) => p.name);
      expect(params).toEqual(["id", "region", "lang"]);
      const codes = Object.keys(doc.paths[path].get.responses);
      expect(codes).toContain("200");
      expect(codes).toContain("400");
    }
    expect(
      Object.keys(doc.paths["/videos/{id}/combined"].get.responses),
    ).toContain("404");
    expect(Object.keys(doc.paths)).toHaveLength(37);
  });
});
