import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  clearHandleCache,
  lookupHandle,
  storeHandle,
} from "../../app/api/v1/channels/_lib";
import { handleChannel } from "../../app/api/v1/channels/[id]/route";
import { handleChannelShorts } from "../../app/api/v1/channels/[id]/shorts/route";
import { handleChannelStreams } from "../../app/api/v1/channels/[id]/streams/route";
import { handleChannelVideos } from "../../app/api/v1/channels/[id]/videos/route";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { cacheSet, clearCache } from "../cache";
import {
  adaptChannelTab,
  type ChannelFeedDeps,
  type ChannelProfileDeps,
  classifyChannelError,
  emptyChannelTab,
  hasChannelTab,
  mapChannelProfile,
  mapChannelShort,
  mapChannelStream,
  mapChannelVideo,
  normalizeChannelKey,
  parseChannelId,
  parseDurationText,
} from "../channels";
import { type ContinuationSearch, clearContinuations } from "../continuations";

beforeEach(() => {
  clearCache();
  clearContinuations();
  clearHandleCache();
});

function req(url: string, requestId = "phase4"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

/** Fake immutable tab pages (mirrors Channel.getContinuation semantics). */
function fakeFeed(pages: Array<unknown[]>): ContinuationSearch {
  const page = (idx: number): ContinuationSearch => ({
    results: [...(pages[idx] ?? [])],
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => page(idx + 1),
  });
  return page(0);
}

const UC = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

const longVideo = (id: string, title: string) => ({
  type: "GridVideo",
  video_id: id,
  title: { text: title },
  length_text: { text: "12:34" },
  published: { text: "2 days ago" },
  view_count: { text: "1M views" },
});

const lockupVideo = (id: string) => ({
  type: "LockupView",
  content_id: id,
  content_type: "VIDEO",
  metadata: { title: { text: "Lockup" } },
  content_image: { thumbnails: [{ url: "https://i/thumb" }] },
});

const lockupShort = (id: string) => ({
  type: "LockupView",
  content_id: id,
  content_type: "SHORT",
  metadata: { title: { text: "Lockup Short" } },
});

const reel = (id: string) => ({
  type: "ReelItem",
  id,
  title: { text: "Reel" },
  views: { text: "5M views" },
});

const shortsLockup = (id: string) => ({
  type: "ShortsLockupView",
  // entity_id is opaque on real clients (collection id) — the watch id comes
  // from the tap endpoint.
  entity_id: `collection-${id}`,
  on_tap_endpoint: { payload: { videoId: id } },
  accessibility_text: "Short alt",
  thumbnail: [{ url: "https://i/short" }],
  overlay_metadata: {
    primary_text: { text: "Short" },
    secondary_text: { text: "1M views" },
  },
});

const liveStream = (id: string) => ({
  type: "Video",
  video_id: id,
  title: { text: "Live now" },
  is_live: true,
  view_count: { text: "1.2K watching" },
  thumbnails: [{ url: "https://i/live" }],
});

const upcomingStream = (id: string) => ({
  type: "GridVideo",
  video_id: id,
  title: { text: "Coming soon" },
  upcoming: new Date("2030-01-01T00:00:00.000Z"),
  upcoming_text: { text: "Scheduled for 2030" },
});

const pastStream = (id: string) => ({
  type: "CompactVideo",
  video_id: id,
  title: { text: "Past stream" },
  length_text: { text: "54:10" },
  view_count: { text: "100K views" },
});

const playlistNode = { type: "GridPlaylist", playlist_id: "PLabc" };
const channelNode = { type: "Channel", channel_id: UC };

function feedDeps(
  pages: Array<unknown[]>,
  resolve: (input: string) => Promise<string> = async (i) => i,
): ChannelFeedDeps {
  return {
    resolveChannelId: resolve,
    fetchFirstPage: async (_id) => fakeFeed(pages),
    continueFeed: async (p) => p.getContinuation(),
  };
}

const c4Profile = {
  header: {
    type: "C4TabbedHeader",
    channel_id: UC,
    channel_handle: { text: "@veritasium" },
    author: {
      id: UC,
      name: "Veritasium",
      is_verified: true,
      thumbnails: [{ url: "https://i/avatar", width: 100, height: 100 }],
    },
    banner: [{ url: "https://i/banner" }],
    subscribers: { text: "18.5M subscribers" },
    videos_count: { text: "521 videos" },
  },
  metadata: {
    title: "Veritasium",
    description: "Science videos.",
    vanity_channel_url: "https://www.youtube.com/@veritasium",
    external_id: UC,
  },
};

describe("channel id validator", () => {
  test("accepts UC ids and @handles", () => {
    expect(parseChannelId(UC)).toEqual({
      ok: true,
      value: { kind: "id", value: UC },
    });
    expect(parseChannelId("@veritasium")).toEqual({
      ok: true,
      value: { kind: "handle", value: "@veritasium" },
    });
  });

  test("rejects empty, video ids, legacy names, and short UC", () => {
    for (const bad of [
      "",
      "   ",
      "dQw4w9WgXcQ",
      "veritasium",
      "UCshort",
      "@",
      "@bad name!",
      "UC",
    ]) {
      const parsed = parseChannelId(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("invalid_channel_id");
        expect(parsed.error.status).toBe(400);
        expect(typeof parsed.error.hint).toBe("string");
      }
    }
  });

  test("normalizeChannelKey lowercases handles only", () => {
    expect(normalizeChannelKey({ kind: "handle", value: "@VeriTasium" })).toBe(
      "@veritasium",
    );
    expect(normalizeChannelKey({ kind: "id", value: UC })).toBe(UC);
  });
});

describe("duration text helper", () => {
  test("parses m:ss and h:mm:ss; rejects garbage", () => {
    expect(parseDurationText("12:34")).toBe(754);
    expect(parseDurationText("1:02:03")).toBe(3723);
    expect(parseDurationText({ text: "5:00" })).toBe(300);
    expect(parseDurationText("25:00:00")).toBe(90_000);
    for (const bad of [
      "",
      "live",
      "12",
      "1:2:3:4",
      "ab:cd",
      "1:60",
      "59:60",
      "1:02:60",
      "1:60:00",
      null,
    ]) {
      expect(parseDurationText(bad)).toBeUndefined();
    }
  });
});

describe("channel profile mapper", () => {
  test("maps C4TabbedHeader shape with counts and badges", () => {
    const dto = mapChannelProfile(c4Profile, UC);
    expect(dto).toMatchObject({
      id: UC,
      handle: "@veritasium",
      title: "Veritasium",
      subscriberCount: 18_500_000,
      videoCount: 521,
      verified: true,
    });
    expect(dto?.avatar?.[0]?.url).toBe("https://i/avatar");
    expect(dto?.banner?.[0]?.url).toBe("https://i/banner");
    expect(dto?.description).toBe("Science videos.");
  });

  test("reads artist + custom badges, falls back to vanity handle", () => {
    const dto = mapChannelProfile(
      {
        header: {
          author: {
            id: UC,
            name: "Artist",
            is_verified_artist: true,
            badges: [
              { label: "Official Artist Channel" },
              { label: "Creator on the Rise" },
            ],
          },
        },
        metadata: {
          title: "Artist",
          vanity_channel_url: "https://www.youtube.com/@artist",
          external_id: UC,
        },
      },
      UC,
    );
    expect(dto?.verified).toBe(false);
    expect(dto?.artistBadge).toBe(true);
    expect(dto?.handle).toBe("@artist");
    // Artist/verified labels are surfaced via flags, not customBadges.
    expect(dto?.customBadges).toEqual(["Creator on the Rise"]);
  });

  test("null on garbage or identity-less payloads", () => {
    expect(mapChannelProfile(null)).toBeNull();
    expect(mapChannelProfile({})).toBeNull();
    expect(mapChannelProfile({ header: {}, metadata: {} })).toBeNull();
    expect(mapChannelProfile({ metadata: { title: "No id" } })).toBeNull();
    // Fallback id rescues an id-less payload that still has a title.
    expect(mapChannelProfile({ metadata: { title: "No id" } }, UC)?.id).toBe(
      UC,
    );
  });
});

describe("type-leakage guards", () => {
  test("videos keeps long-form only", () => {
    expect(mapChannelVideo(longVideo("v1", "V"))).toMatchObject({
      id: "v1",
      title: "V",
      durationSeconds: 754,
      publishedText: "2 days ago",
      viewText: "1M views",
    });
    expect(mapChannelVideo(lockupVideo("lv1"))).toMatchObject({ id: "lv1" });
    expect(
      mapChannelVideo({
        type: "LockupView",
        content_id: "lv2",
        content_type: "VIDEO",
        length_text: { text: "8:15" },
        published: { text: "a week ago" },
        metadata: {
          title: { text: "Lockup stats" },
          view_count: { text: "42K views" },
        },
      }),
    ).toMatchObject({
      id: "lv2",
      title: "Lockup stats",
      durationSeconds: 495,
      publishedText: "a week ago",
      viewText: "42K views",
    });
    expect(mapChannelVideo(reel("r1"))).toBeNull();
    expect(mapChannelVideo(shortsLockup("s1"))).toBeNull();
    expect(mapChannelVideo(lockupShort("ls1"))).toBeNull();
    expect(mapChannelVideo(playlistNode)).toBeNull();
    expect(mapChannelVideo(channelNode)).toBeNull();
    expect(mapChannelVideo({ type: "Video", title: "No id" })).toBeNull();
  });

  test("shorts keeps shorts only", () => {
    expect(mapChannelShort(reel("r1"))).toMatchObject({
      id: "r1",
      viewText: "5M views",
    });
    expect(mapChannelShort(shortsLockup("s1"))).toMatchObject({ id: "s1" });
    expect(mapChannelShort(lockupShort("ls1"))).toMatchObject({ id: "ls1" });
    // Opaque entity_id alone is not a watch id — dropped, never emitted.
    expect(
      mapChannelShort({
        type: "ShortsLockupView",
        entity_id: "opaque-collection-id",
        overlay_metadata: { primary_text: { text: "Short" } },
      }),
    ).toBeNull();
    expect(mapChannelShort(longVideo("v1", "V"))).toBeNull();
    expect(mapChannelShort(lockupVideo("lv1"))).toBeNull();
    expect(mapChannelShort(playlistNode)).toBeNull();
    expect(mapChannelShort({ type: "ReelItem", title: "No id" })).toBeNull();
  });

  test("streams keeps live/upcoming/past with flags, drops shorts", () => {
    const live = mapChannelStream(liveStream("live1"));
    expect(live).toMatchObject({
      id: "live1",
      isLive: true,
      isUpcoming: false,
      viewersText: "1.2K watching",
    });
    expect(live?.viewText).toBeUndefined();
    const up = mapChannelStream(upcomingStream("up1"));
    expect(up).toMatchObject({
      id: "up1",
      isLive: false,
      isUpcoming: true,
      scheduledStart: "2030-01-01T00:00:00.000Z",
    });
    const past = mapChannelStream(pastStream("p1"));
    expect(past).toMatchObject({
      id: "p1",
      isLive: false,
      isUpcoming: false,
      durationSeconds: 3250,
      viewText: "100K views",
    });
    expect(mapChannelStream(reel("r1"))).toBeNull();
    expect(mapChannelStream(shortsLockup("s1"))).toBeNull();
    expect(mapChannelStream(lockupShort("ls1"))).toBeNull();
    expect(mapChannelStream(playlistNode)).toBeNull();
  });

  test("streams runs live/upcoming detection on LockupView nodes too", () => {
    const liveLockup = mapChannelStream({
      type: "LockupView",
      content_id: "ll1",
      content_type: "LIVE",
      is_live: true,
      metadata: { title: { text: "Lockup live" } },
      view_count: { text: "3.1K watching" },
    });
    expect(liveLockup).toMatchObject({
      id: "ll1",
      isLive: true,
      isUpcoming: false,
      viewersText: "3.1K watching",
    });
    const upcomingLockup = mapChannelStream({
      type: "LockupView",
      content_id: "ll2",
      content_type: "VIDEO",
      metadata: { title: { text: "Lockup soon" } },
      upcoming_text: { text: "Premiere" },
      badges: [{ label: "Upcoming" }],
    });
    expect(upcomingLockup).toMatchObject({
      id: "ll2",
      isLive: false,
      isUpcoming: true,
    });
    const pastLockup = mapChannelStream(lockupVideo("ll3"));
    expect(pastLockup).toMatchObject({
      id: "ll3",
      isLive: false,
      isUpcoming: false,
    });
  });

  test("stream lockups read stats nested in metadata views", () => {
    const nested = mapChannelStream({
      type: "LockupView",
      content_id: "ls1",
      content_type: "VIDEO",
      metadata: {
        title: { text: "Nested stats" },
        view_count: { text: "10K views" },
        published: { text: "3 days ago" },
        length_text: { text: "1:05:00" },
      },
    });
    expect(nested).toMatchObject({
      id: "ls1",
      title: "Nested stats",
      viewText: "10K views",
      publishedText: "3 days ago",
      durationSeconds: 3900,
    });
  });

  test("hasChannelTab: explicit false skips, true/unknown proceeds", () => {
    expect(hasChannelTab({ has_videos: true }, "videos")).toBe(true);
    expect(hasChannelTab({ has_videos: false }, "videos")).toBe(false);
    expect(hasChannelTab({}, "videos")).toBe(true);
    expect(hasChannelTab({ has_shorts: false }, "shorts")).toBe(false);
    expect(hasChannelTab({}, "shorts")).toBe(true);
    expect(hasChannelTab({ has_live_streams: false }, "streams")).toBe(false);
    expect(hasChannelTab({}, "streams")).toBe(true);
  });
});

describe("classifyChannelError", () => {
  test("timeout -> 504; missing -> 404; rest -> 502", () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(classifyChannelError(timeout)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    for (const msg of [
      "channel_not_found: UCx",
      "Channel not found",
      "Failed to resolve URL. Expected a NavigationEndpoint but got undefined: @nope",
      "Invalid channel",
      "This channel has been terminated",
      // Real upstream shape for an unknown @handle: resolveURL throws the
      // request failure verbatim (resolve_url + 404, no word "channel").
      "Request to https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url?prettyPrint=false failed with status code 404",
    ]) {
      expect(classifyChannelError(new Error(msg))).toMatchObject({
        code: "channel_not_found",
        status: 404,
      });
    }
    // A resolve_url 500 (transient) is NOT a missing channel.
    expect(
      classifyChannelError(
        new Error(
          "Request to https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url?prettyPrint=false failed with status code 500",
        ),
      ),
    ).toMatchObject({ code: "upstream_degraded", status: 502 });
    expect(classifyChannelError(new Error("upstream down"))).toMatchObject({
      code: "upstream_degraded",
      status: 502,
    });
  });

  test("bare private/deleted/removed without channel context stays 502", () => {
    for (const msg of ["private video", "deleted", "removed by user"]) {
      expect(classifyChannelError(new Error(msg))).toMatchObject({
        code: "upstream_degraded",
        status: 502,
      });
    }
    for (const msg of [
      "this channel is private",
      "channel deleted",
      "channel page removed",
    ]) {
      expect(classifyChannelError(new Error(msg))).toMatchObject({
        code: "channel_not_found",
        status: 404,
      });
    }
  });
});

describe("handle -> UC id map cache", () => {
  test("roundtrip hit, miss, and expiry", () => {
    expect(lookupHandle("@x")).toBeUndefined();
    storeHandle("@x", UC);
    expect(lookupHandle("@x")).toBe(UC);
    storeHandle("@expired", UC, -1);
    expect(lookupHandle("@expired")).toBeUndefined();
  });

  test("bounded: oldest entry evicted past the cap", () => {
    for (let i = 0; i < 501; i += 1) {
      storeHandle(`@h${i}`, UC);
    }
    expect(lookupHandle("@h0")).toBeUndefined();
    expect(lookupHandle("@h500")).toBe(UC);
  });
});

describe("tab adapter", () => {
  test("adapts videos + re-adapts continuations; empty tab is terminal", async () => {
    const raw = {
      videos: [longVideo("a", "A")],
      has_continuation: true,
      getContinuation: async () => ({
        videos: [longVideo("b", "B")],
        has_continuation: false,
        getContinuation: async () => ({}),
      }),
    };
    const first = adaptChannelTab(raw);
    expect(first.results).toHaveLength(1);
    expect(first.has_continuation).toBe(true);
    const second = await first.getContinuation();
    expect(second.results).toHaveLength(1);
    expect(second.has_continuation).toBe(false);
    const empty = emptyChannelTab();
    expect(empty.results).toEqual([]);
    expect(empty.has_continuation).toBe(false);
  });

  test("non-iterable videos degrades to an empty page (never throws)", () => {
    const first = adaptChannelTab({
      videos: { length: 2 } as unknown as Array<unknown>,
      has_continuation: false,
      getContinuation: async () => ({}),
    });
    expect(first.results).toEqual([]);
  });
});

describe("profile handler (mocked upstream)", () => {
  const deps: ChannelProfileDeps = {
    resolveChannelId: async (input) => (input.startsWith("@") ? UC : input),
    fetchProfile: async (_id) => c4Profile,
  };

  test("invalid id -> 400 invalid_channel_id, upstream untouched", async () => {
    let called = false;
    const res = await handleChannel(
      req(`http://x/api/v1/channels/nope`),
      "nope",
      {
        resolveChannelId: async () => {
          called = true;
          return UC;
        },
        fetchProfile: async () => {
          called = true;
          return c4Profile;
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_channel_id");
    expect(called).toBe(false);
  });

  test("success envelope: profile + staticish cache + headers", async () => {
    const res = await handleChannel(
      req(`http://x/api/v1/channels/${UC}`),
      UC,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: UC,
      handle: "@veritasium",
      title: "Veritasium",
      verified: true,
    });
    expect(body.page).toEqual({ next: null });
    expect(body.meta).toMatchObject({
      region: "US",
      lang: "en",
      cached: false,
      requestId: "phase4",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("X-Request-Id")).toBe("phase4");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
  });

  test("@handle shares the UC cache entry", async () => {
    await handleChannel(
      req(`http://x/api/v1/channels/@veritasium`),
      "@veritasium",
      deps,
    );
    const second = await handleChannel(
      req(`http://x/api/v1/channels/${UC}`),
      UC,
      deps,
    );
    expect((await second.json()).meta.cached).toBe(true);
  });

  test("missing channel -> 404 channel_not_found (never 500)", async () => {
    const res = await handleChannel(req(`http://x/api/v1/channels/${UC}`), UC, {
      resolveChannelId: async (i) => i,
      fetchProfile: async () => {
        throw new Error("channel_not_found: UCx");
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("channel_not_found");
  });

  test("unresolvable handle -> 404 channel_not_found", async () => {
    const res = await handleChannel(
      req("http://x/api/v1/channels/@nope"),
      "@nope",
      {
        resolveChannelId: async () => {
          // Real upstream shape: resolveURL throws the request failure
          // verbatim for an unknown handle (resolve_url + 404).
          throw new Error(
            "Request to https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url?prettyPrint=false failed with status code 404",
          );
        },
        fetchProfile: async () => c4Profile,
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("channel_not_found");
  });

  test("stale-on-error serves cached profile with warning", async () => {
    const primed = await (
      await handleChannel(req(`http://x/api/v1/channels/${UC}`), UC, deps)
    ).json();
    cacheSet(`channel:profile:v1:${UC}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleChannel(req(`http://x/api/v1/channels/${UC}`), UC, {
      resolveChannelId: async (i) => i,
      fetchProfile: async () => {
        throw new Error("upstream down");
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("definitive not-found never serves stale", async () => {
    const primed = await (
      await handleChannel(req(`http://x/api/v1/channels/${UC}`), UC, deps)
    ).json();
    cacheSet(`channel:profile:v1:${UC}`, primed.data, -1, 60 * 60 * 1000);
    const res = await handleChannel(req(`http://x/api/v1/channels/${UC}`), UC, {
      resolveChannelId: async (i) => i,
      fetchProfile: async () => {
        throw new Error("channel_not_found: gone");
      },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("channel_not_found");
  });
});

describe("channel feed handlers (mocked upstream)", () => {
  test("invalid id -> 400 invalid_channel_id, upstream untouched", async () => {
    for (const h of [
      handleChannelVideos,
      handleChannelShorts,
      handleChannelStreams,
    ]) {
      let called = false;
      const res = await h(req("http://x/api/v1/channels/x"), "not a channel!", {
        resolveChannelId: async () => {
          called = true;
          return UC;
        },
        fetchFirstPage: async () => {
          called = true;
          return fakeFeed([[]]);
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_channel_id");
      expect(called).toBe(false);
    }
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=many`),
      UC,
      feedDeps([[longVideo("v1", "V")]]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("videos: first page maps DTOs, mints cursor; cursor walks page 2", async () => {
    const deps = feedDeps([
      [longVideo("v1", "V1"), reel("r1"), longVideo("v2", "V2")],
      [longVideo("v3", "V3")],
    ]);
    const first = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=3`),
      UC,
      deps,
    );
    expect(first.status).toBe(200);
    const b1 = await first.json();
    // The reel sits inside the limit slice but is dropped by the
    // type-leakage guard (never counted as data).
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual(["v1", "v2"]);
    expect(typeof b1.page.next).toBe("string");
    expect(b1.meta.requestId).toBe("phase4");
    expect(first.headers.get("X-Request-Id")).toBe("phase4");
    expect(first.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");

    const second = await handleChannelVideos(
      req(
        `http://x/api/v1/channels/${UC}/videos?cursor=${b1.page.next}&limit=3`,
      ),
      UC,
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["v3"]);
    expect(b2.page.next).toBeNull();
    expect(second.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("shorts: only shorts DTOs; streams: flags on every item", async () => {
    const shorts = await handleChannelShorts(
      req(`http://x/api/v1/channels/${UC}/shorts?limit=5`),
      UC,
      feedDeps([[reel("r1"), longVideo("v1", "V"), shortsLockup("s1")]]),
    );
    const sb = await shorts.json();
    expect(sb.data.map((d: { id: string }) => d.id)).toEqual(["r1", "s1"]);

    const streams = await handleChannelStreams(
      req(`http://x/api/v1/channels/${UC}/streams?limit=5`),
      UC,
      feedDeps([
        [liveStream("l1"), upcomingStream("u1"), pastStream("p1"), reel("r1")],
      ]),
    );
    const stb = await streams.json();
    expect(stb.data.map((d: { id: string }) => d.id)).toEqual([
      "l1",
      "u1",
      "p1",
    ]);
    expect(stb.data[0]).toMatchObject({ isLive: true, isUpcoming: false });
    expect(stb.data[1]).toMatchObject({ isLive: false, isUpcoming: true });
    expect(stb.data[2]).toMatchObject({ isLive: false, isUpcoming: false });
  });

  test("unknown cursor -> [] + next: null (never 404)", async () => {
    const res = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?cursor=nope`),
      UC,
      feedDeps([[longVideo("v1", "V")]]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("missing tab (has_shorts/has_live false) -> terminal empty page", async () => {
    const missing = {
      resolveChannelId: async (i: string) => i,
      fetchFirstPage: async (_id: string) => emptyChannelTab(),
      continueFeed: async () => {
        throw new Error("unreached");
      },
    };
    for (const [h, seg] of [
      [handleChannelShorts, "shorts"],
      [handleChannelStreams, "streams"],
    ] as const) {
      const res = await h(
        req(`http://x/api/v1/channels/${UC}/${seg}?limit=5`),
        UC,
        missing,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.page).toEqual({ next: null });
      expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
    }
  });

  test("empty upstream videos tab -> 200 data:[] + next:null (never 404)", async () => {
    const res = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=5`),
      UC,
      feedDeps([[]]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("exhausted first page keeps the public channelFeed TTL", async () => {
    const res = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=5`),
      UC,
      feedDeps([[longVideo("only", "Only")]]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
    expect((await res.json()).page.next).toBeNull();
  });

  test("cross-channel cursor -> [] + next: null (never foreign items)", async () => {
    const deps = feedDeps([
      [longVideo("v1", "V1"), longVideo("v2", "V2")],
      [longVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handleChannelVideos(
        req(`http://x/api/v1/channels/${UC}/videos?limit=2`),
        UC,
        deps,
      )
    ).json();
    const other = "UC_AAAAAAAAAAAAAAAAAAAAAAAA";
    const cross = await handleChannelVideos(
      req(
        `http://x/api/v1/channels/${other}/videos?cursor=${b1.page.next}&limit=2`,
      ),
      other,
      deps,
    );
    const body = await cross.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("cross-endpoint cursor (videos -> shorts) -> [] + next: null", async () => {
    const deps = feedDeps([
      [longVideo("v1", "V1"), longVideo("v2", "V2")],
      [longVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handleChannelVideos(
        req(`http://x/api/v1/channels/${UC}/videos?limit=2`),
        UC,
        deps,
      )
    ).json();
    const cross = await handleChannelShorts(
      req(
        `http://x/api/v1/channels/${UC}/shorts?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      deps,
    );
    const body = await cross.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("handle and UC form share scope, cache, and cursors (resolved UC id)", async () => {
    const deps = feedDeps(
      [[longVideo("v1", "V1"), longVideo("v2", "V2")], [longVideo("v3", "V3")]],
      async (input) => (input.startsWith("@") ? UC : input),
    );
    const b1 = await (
      await handleChannelVideos(
        req(`http://x/api/v1/channels/@SomeHandle/videos?limit=2`),
        "@SomeHandle",
        deps,
      )
    ).json();
    expect(typeof b1.page.next).toBe("string");
    // Same cursor presented under the UC form resolves to the same scope and
    // walks page 2 — resolution runs on the cursor path too.
    let resolvedOnCursorPath = 0;
    const second = await handleChannelVideos(
      req(
        `http://x/api/v1/channels/${UC}/videos?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      {
        ...deps,
        resolveChannelId: async (input) => {
          resolvedOnCursorPath += 1;
          return input.startsWith("@") ? UC : input;
        },
      },
    );
    expect(resolvedOnCursorPath).toBe(1);
    expect((await second.json()).data.map((d: { id: string }) => d.id)).toEqual(
      ["v3"],
    );
    // And the UC first page is an L0 hit of the handle-primed entry.
    const ucFirst = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=2`),
      UC,
      deps,
    );
    expect((await ucFirst.json()).meta.cached).toBe(true);
  });

  test("continuation fetch failure -> [] + continuation_failed warning", async () => {
    const deps = feedDeps([
      [longVideo("v1", "V1"), longVideo("v2", "V2")],
      [longVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handleChannelVideos(
        req(`http://x/api/v1/channels/${UC}/videos?limit=2`),
        UC,
        deps,
      )
    ).json();
    // Buffer holds exactly `limit` items with upstream continuation left, so
    // the cursor request must call continueFeed — which throws here.
    const res = await handleChannelVideos(
      req(
        `http://x/api/v1/channels/${UC}/videos?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      {
        ...deps,
        continueFeed: async () => {
          throw new Error("upstream down");
        },
      },
    );
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
    expect(body.warnings[0].code).toBe("continuation_failed");
  });

  test("channel_not_found -> 404; timeout -> 504; generic -> 502", async () => {
    const nf = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos`),
      UC,
      {
        resolveChannelId: async (i) => i,
        fetchFirstPage: async () => {
          throw new Error("channel_not_found: UCx");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("channel_not_found");

    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos`),
      UC,
      {
        resolveChannelId: async (i) => i,
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

  test("stale-on-error serves items with warning; not-found never serves stale", async () => {
    const deps = feedDeps([[longVideo("v1", "V1")]]);
    const primed = await (
      await handleChannelVideos(
        req(`http://x/api/v1/channels/${UC}/videos?limit=1`),
        UC,
        deps,
      )
    ).json();
    cacheSet(
      `channel:videos:v1:${UC}:1`,
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=1`),
      UC,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("upstream down");
        },
      },
    );
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.data).toEqual(primed.data);
    expect(staleBody.meta.cached).toBe(true);
    expect(staleBody.warnings[0].code).toBe("stale_served");

    const nf = await handleChannelVideos(
      req(`http://x/api/v1/channels/${UC}/videos?limit=1`),
      UC,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("channel_not_found: gone");
        },
      },
    );
    expect(nf.status).toBe(404);
  });
});

describe("openapi phase 4", () => {
  test("lists the 4 channel paths with params and typed responses", () => {
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
      "/channels/{id}",
      "/channels/{id}/videos",
      "/channels/{id}/shorts",
      "/channels/{id}/streams",
    ]) {
      expect(Object.keys(paths)).toContain(p);
    }
    expect(paths["/channels/{id}"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining(["id", "region", "lang"]),
    );
    for (const p of [
      "/channels/{id}/videos",
      "/channels/{id}/shorts",
      "/channels/{id}/streams",
    ]) {
      expect(paths[p].get.parameters.map((q) => q.name)).toEqual(
        expect.arrayContaining(["id", "limit", "cursor", "region", "lang"]),
      );
      const codes = Object.keys(paths[p].get.responses);
      for (const c of ["200", "400", "404", "429", "502", "504"]) {
        expect(codes).toContain(c);
      }
    }
    expect(Object.keys(paths["/channels/{id}"].get.responses)).toContain("404");
  });
});
