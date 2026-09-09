import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { clearHandleCache } from "../../app/api/v1/channels/_lib";
import { handleChannelPlaylists } from "../../app/api/v1/channels/[id]/playlists/route";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { fetchChannelPlaylistsTab } from "../../app/api/v1/playlists/_lib";
import { handlePlaylistItems } from "../../app/api/v1/playlists/[id]/items/route";
import { handlePlaylist } from "../../app/api/v1/playlists/[id]/route";
import { cacheSet, clearCache } from "../cache";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import {
  adaptChannelPlaylistsPage,
  adaptPlaylistFeed,
  type ChannelPlaylistsDeps,
  classifyPlaylistError,
  emptyPlaylistFeed,
  isTransientUpstreamError,
  mapChannelPlaylist,
  mapPlaylistItem,
  mapPlaylistProfile,
  type PlaylistFeedDeps,
  type PlaylistProfileDeps,
  parsePlaylistId,
} from "../playlists";

beforeEach(() => {
  clearCache();
  clearContinuations();
  clearHandleCache();
});

function req(url: string, requestId = "phase5"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

/** Fake immutable feed pages (mirrors Playlist.getContinuation semantics). */
function fakeFeed(pages: Array<unknown[]>): ContinuationSearch {
  const page = (idx: number): ContinuationSearch => ({
    results: [...(pages[idx] ?? [])],
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => page(idx + 1),
  });
  return page(0);
}

const PL = "PLplXQ2cg9B_qrCVd1J_iId5SvP8Kf_BfS";
const UC = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

const playlistVideo = (id: string, title: string, index = 1) => ({
  type: "PlaylistVideo",
  video_id: id,
  index: { text: String(index) },
  title: { text: title },
  author: { name: "Some Channel" },
  thumbnails: [{ url: "https://i/thumb" }],
  duration: { text: "8:15", seconds: 495 },
  is_playable: true,
});

const deletedVideo = (index = 2) => ({
  type: "PlaylistVideo",
  index: { text: String(index) },
  title: { text: "Deleted video" },
  author: { name: "" },
  is_playable: false,
});

const privateVideo = (id: string, index = 3) => ({
  type: "PlaylistVideo",
  video_id: id,
  index: { text: String(index) },
  title: { text: "Private video" },
  is_playable: false,
});

const lockupItem = (id: string) => ({
  type: "LockupView",
  content_id: id,
  content_type: "VIDEO",
  metadata: { title: { text: "Lockup item" } },
  content_image: { thumbnails: [{ url: "https://i/lockup" }] },
});

const gridPlaylist = (id: string, title: string) => ({
  type: "GridPlaylist",
  playlist_id: id,
  title: { text: title },
  video_count: { text: "127 videos" },
  thumbnails: [{ url: "https://i/pl" }],
});

const lockupPlaylist = (id: string) => ({
  type: "LockupView",
  content_id: id,
  content_type: "PLAYLIST",
  metadata: { title: { text: "Lockup playlist" } },
});

const otherVideoNode = { type: "GridVideo", video_id: "v9" };

const rawPlaylist = (
  items: unknown[],
  extra: Record<string, unknown> = {},
  continuation: unknown[] = [],
) => ({
  info: {
    title: { text: "My Playlist" },
    description: "A great list.",
    author: { id: UC, name: "Some Channel" },
    thumbnails: [{ url: "https://i/plthumb" }],
    total_items: "42",
    views: "1M views",
    privacy: "PUBLIC",
  },
  items,
  has_continuation: continuation.length > 0,
  getContinuation: async () => ({
    items: continuation,
    has_continuation: false,
    getContinuation: async () => ({}),
  }),
  ...extra,
});

function profileDeps(
  firstItems: unknown[],
  continuation: unknown[] = [],
): PlaylistProfileDeps {
  return {
    fetchPlaylist: async (_id) => rawPlaylist(firstItems, {}, continuation),
  };
}

function itemsDeps(pages: Array<unknown[]>): PlaylistFeedDeps {
  return {
    fetchFirstPage: async (_id) => fakeFeed(pages),
    continueFeed: async (p) => p.getContinuation(),
  };
}

function channelPlaylistsDeps(
  pages: Array<unknown[]>,
  resolve: (input: string) => Promise<string> = async (i) => i,
): ChannelPlaylistsDeps {
  return {
    resolveChannelId: resolve,
    fetchFirstPage: async (_id) => fakeFeed(pages),
    continueFeed: async (p) => p.getContinuation(),
  };
}

describe("playlist id validator", () => {
  test("accepts PL/UU/RD/OL ids", () => {
    for (const id of [
      PL,
      "UU_x5XG1OV2P6uZZ5FSM9Ttw",
      "RDdQw4w9WgXcQ",
      "OLAK5uy_labeled",
      "ab",
    ]) {
      expect(parsePlaylistId(id)).toEqual({ ok: true, value: { value: id } });
    }
  });

  test("rejects empty, slashes, spaces, and overlong ids", () => {
    for (const bad of [
      "",
      "   ",
      "PL with space",
      "PL/with/slash",
      "PL?x=1",
      "x",
      "P".repeat(65),
    ]) {
      const parsed = parsePlaylistId(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("invalid_playlist_id");
        expect(parsed.error.status).toBe(400);
        expect(typeof parsed.error.hint).toBe("string");
      }
    }
  });
});

describe("playlist profile mapper", () => {
  test("maps info block with author, counts, and privacy", () => {
    const dto = mapPlaylistProfile(rawPlaylist([]), PL);
    expect(dto).toMatchObject({
      id: PL,
      title: "My Playlist",
      description: "A great list.",
      channelId: UC,
      channelTitle: "Some Channel",
      itemCount: 42,
      privacy: "PUBLIC",
    });
    expect(dto?.thumbnails?.[0]?.url).toBe("https://i/plthumb");
  });

  test("falls back to the request id; null on garbage", () => {
    const noId = rawPlaylist([]);
    delete (noId.info as Record<string, unknown>).title;
    expect(mapPlaylistProfile(noId, PL)).toBeNull();
    expect(mapPlaylistProfile(null)).toBeNull();
    expect(mapPlaylistProfile({})).toBeNull();
    expect(mapPlaylistProfile({ info: {} })).toBeNull();
    const idLess = { info: { title: { text: "T" } } };
    expect(mapPlaylistProfile(idLess, PL)?.id).toBe(PL);
  });
});

describe("playlist item mapper (placeholders)", () => {
  test("playable videos map with position, channel, and duration", () => {
    expect(mapPlaylistItem(playlistVideo("v1", "V1", 7))).toMatchObject({
      id: "v1",
      title: "V1",
      kind: "video",
      position: 7,
      channelTitle: "Some Channel",
      durationSeconds: 495,
    });
    expect(mapPlaylistItem(lockupItem("lv1"))).toMatchObject({
      id: "lv1",
      kind: "video",
    });
  });

  test("deleted/private degrade to typed placeholders, never null", () => {
    const deleted = mapPlaylistItem(deletedVideo());
    expect(deleted).toMatchObject({ title: "Deleted video", kind: "deleted" });
    expect(deleted).not.toBeNull();
    const priv = mapPlaylistItem(privateVideo("pv1"));
    expect(priv).toMatchObject({
      id: "pv1",
      title: "Private video",
      kind: "private",
    });
    // Unknown unplayable titles default to private, keeping an id when served.
    expect(
      mapPlaylistItem({
        type: "PlaylistVideo",
        video_id: "x1",
        title: { text: "Unavailable" },
        is_playable: false,
      }),
    ).toMatchObject({ id: "x1", kind: "private" });
  });

  test("non-item nodes map to null (dropped, never placeholders)", () => {
    expect(mapPlaylistItem(otherVideoNode)).toBeNull();
    expect(
      mapPlaylistItem({ type: "GridPlaylist", playlist_id: "PLx" }),
    ).toBeNull();
    expect(
      mapPlaylistItem({
        type: "LockupView",
        content_id: "lp1",
        content_type: "PLAYLIST",
      }),
    ).toBeNull();
    expect(mapPlaylistItem(null)).toBeNull();
    expect(
      mapPlaylistItem({ type: "PlaylistVideo", title: "No id at all" }),
    ).toBeNull();
  });
});

describe("channel playlist mapper", () => {
  test("keeps GridPlaylist and LockupView PLAYLIST only", () => {
    expect(mapChannelPlaylist(gridPlaylist("PL1", "P1"))).toMatchObject({
      id: "PL1",
      title: "P1",
      itemCount: 127,
    });
    expect(mapChannelPlaylist(lockupPlaylist("PL2"))).toMatchObject({
      id: "PL2",
      title: "Lockup playlist",
    });
    expect(
      mapChannelPlaylist({ ...lockupPlaylist("PL3"), content_type: "VIDEO" }),
    ).toBeNull();
    expect(mapChannelPlaylist(otherVideoNode)).toBeNull();
    expect(mapChannelPlaylist(null)).toBeNull();
    expect(
      mapChannelPlaylist({ type: "GridPlaylist", title: "No id" }),
    ).toBeNull();
  });
});

describe("classifyPlaylistError", () => {
  test("timeout -> 504; missing -> 404; rest -> 502", () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(classifyPlaylistError(timeout)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    for (const msg of [
      "playlist_not_found: PLx",
      "Playlist not found",
      "The playlist does not exist.",
      "This playlist type is unviewable.",
      "This playlist is private",
      "The playlist has been deleted",
      "Invalid playlist id",
      "Request to https://youtubei.googleapis.com/youtubei/v1/browse?prettyPrint=false failed with status code 404 (playlist)",
    ]) {
      expect(classifyPlaylistError(new Error(msg))).toMatchObject({
        code: "playlist_not_found",
        status: 404,
      });
    }
    expect(classifyPlaylistError(new Error("upstream down"))).toMatchObject({
      code: "upstream_degraded",
      status: 502,
    });
  });
});

describe("playlist feed adapter", () => {
  test("adapts items + re-adapts continuations; empty is terminal", async () => {
    const raw = {
      items: [playlistVideo("a", "A")],
      has_continuation: true,
      getContinuation: async () => ({
        items: [playlistVideo("b", "B")],
        has_continuation: false,
        getContinuation: async () => ({}),
      }),
    };
    const first = adaptPlaylistFeed(raw);
    expect(first.results).toHaveLength(1);
    expect(first.has_continuation).toBe(true);
    const second = await first.getContinuation();
    expect(second.results).toHaveLength(1);
    expect(second.has_continuation).toBe(false);
    const empty = emptyPlaylistFeed();
    expect(empty.results).toEqual([]);
    expect(empty.has_continuation).toBe(false);
  });

  test("non-iterable items degrades to an empty page (never throws)", () => {
    const first = adaptPlaylistFeed({
      items: { length: 2 } as unknown as Array<unknown>,
      has_continuation: false,
      getContinuation: async () => ({}),
    });
    expect(first.results).toEqual([]);
  });
});

describe("isTransientUpstreamError (stale-retry gate)", () => {
  test("timeout, 429, and 5xx are transient", () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    expect(isTransientUpstreamError(timeout)).toBe(true);
    expect(isTransientUpstreamError(new Error("aborted"))).toBe(true);
    expect(
      isTransientUpstreamError(
        new Error("Request failed with status code 429"),
      ),
    ).toBe(true);
    expect(
      isTransientUpstreamError(new Error("failed with status code 503")),
    ).toBe(true);
    expect(isTransientUpstreamError(new Error("bad gateway upstream"))).toBe(
      true,
    );
  });

  test("not-found, unviewable, and other 4xx are definitive (never stale)", () => {
    for (const msg of [
      "playlist_not_found: PLx",
      "channel_not_found: UCx",
      "This playlist type is unviewable.",
      "The playlist does not exist.",
      "Request failed with status code 400",
      "Request failed with status code 403",
      "upstream down",
    ]) {
      expect(isTransientUpstreamError(new Error(msg))).toBe(false);
    }
  });
});

describe("channel playlists page adapter", () => {
  /** Live getPlaylists() tab shape: playlists memo populated, videos empty. */
  const playlistsTab = (nodes: unknown[], continuation: unknown[] = []) => ({
    playlists: nodes,
    videos: [],
    has_continuation: continuation.length > 0,
    getContinuation: async () => ({
      playlists: continuation,
      videos: [],
      has_continuation: false,
      getContinuation: async () => ({}),
    }),
  });

  test("reads the playlists memo while videos stays empty + re-adapts", async () => {
    const first = adaptChannelPlaylistsPage(
      playlistsTab(
        [lockupPlaylist("PL1"), gridPlaylist("PL2", "P2")],
        [lockupPlaylist("PL3")],
      ),
    );
    expect(first.results).toHaveLength(2);
    expect(first.has_continuation).toBe(true);
    const second = await first.getContinuation();
    expect(second.results).toHaveLength(1);
    expect(second.has_continuation).toBe(false);
  });

  test("handler serves playlists-memo tabs end to end (was data:[] live)", async () => {
    const deps: ChannelPlaylistsDeps = {
      resolveChannelId: async (i) => i,
      fetchFirstPage: async (_id) =>
        adaptChannelPlaylistsPage(
          playlistsTab(
            [lockupPlaylist("PL1"), lockupPlaylist("PL2")],
            [lockupPlaylist("PL3")],
          ),
        ),
      continueFeed: async (p) => p.getContinuation(),
    };
    const first = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=2`),
      UC,
      deps,
    );
    const b1 = await first.json();
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual(["PL1", "PL2"]);
    expect(typeof b1.page.next).toBe("string");
    const second = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["PL3"]);
    expect(b2.page.next).toBeNull();
  });

  test("raw current_tab fallback harvests items without memos", async () => {
    const page = await fetchChannelPlaylistsTab({
      has_playlists: true,
      getPlaylists: async () => ({
        current_tab: {
          content: {
            contents: [{ contents: [{ items: [lockupPlaylist("PL9")] }] }],
          },
        },
        has_continuation: false,
        getContinuation: async () => ({}),
      }),
    });
    expect(page.results).toHaveLength(1);
    expect(page.results.map((n) => mapChannelPlaylist(n))).toMatchObject([
      { id: "PL9" },
    ]);
  });

  test("missing memos and tab -> empty page (never throws)", async () => {
    const page = adaptChannelPlaylistsPage({
      has_continuation: false,
      getContinuation: async () => ({}),
    });
    expect(page.results).toEqual([]);
  });
});

describe("channel playlists tab selector (_lib)", () => {
  test("has_playlists false skips the tab call -> terminal empty page", async () => {
    let called = false;
    const page = await fetchChannelPlaylistsTab({
      has_playlists: false,
      getPlaylists: async () => {
        called = true;
        return {};
      },
    });
    expect(called).toBe(false);
    expect(page.results).toEqual([]);
    expect(page.has_continuation).toBe(false);
  });

  test("missing getPlaylists falls back to empty (never throws)", async () => {
    const page = await fetchChannelPlaylistsTab({ has_playlists: true });
    expect(page.results).toEqual([]);
    expect(page.has_continuation).toBe(false);
  });

  test("success adapts the playlists tab (playlists memo, not videos)", async () => {
    const page = await fetchChannelPlaylistsTab({
      has_playlists: true,
      getPlaylists: async () => ({
        playlists: [gridPlaylist("PL1", "P1")],
        videos: [],
        has_continuation: false,
        getContinuation: async () => ({}),
      }),
    });
    expect(page.results).toHaveLength(1);
  });
});

describe("playlist profile handler (mocked upstream)", () => {
  test("invalid id -> 400 invalid_playlist_id, upstream untouched", async () => {
    let called = false;
    const res = await handlePlaylist(
      req("http://x/api/v1/playlists/nope!"),
      "nope!",
      {
        fetchPlaylist: async () => {
          called = true;
          return {};
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_playlist_id");
    expect(called).toBe(false);
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=many`),
      PL,
      profileDeps([playlistVideo("v1", "V1")]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("success envelope: metadata + first items, playlist cache + headers", async () => {
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=3`),
      PL,
      profileDeps(
        [playlistVideo("v1", "V1"), deletedVideo(), privateVideo("pv1")],
        [playlistVideo("v2", "V2")],
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.playlist).toMatchObject({
      id: PL,
      title: "My Playlist",
      channelId: UC,
    });
    // Deleted/private items degrade to placeholders inline, never dropped.
    expect(body.data.items.map((d: { kind: string }) => d.kind)).toEqual([
      "video",
      "deleted",
      "private",
    ]);
    expect(typeof body.page.next).toBe("string");
    expect(body.meta).toMatchObject({
      region: "US",
      lang: "en",
      cached: false,
      requestId: "phase5",
    });
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("X-Request-Id")).toBe("phase5");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    // A continuation remains -> process-local cursor -> no-store.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("exhausted playlist keeps the public playlist TTL", async () => {
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=5`),
      PL,
      profileDeps([playlistVideo("only", "Only")]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
    expect((await res.json()).page.next).toBeNull();
  });

  test("profile cursor resolves under /items (pages 2+)", async () => {
    const deps = profileDeps(
      [playlistVideo("v1", "V1")],
      [playlistVideo("v2", "V2")],
    );
    const b1 = await (
      await handlePlaylist(
        req(`http://x/api/v1/playlists/${PL}?limit=1`),
        PL,
        deps,
      )
    ).json();
    expect(typeof b1.page.next).toBe("string");
    const second = await handlePlaylistItems(
      req(
        `http://x/api/v1/playlists/${PL}/items?cursor=${b1.page.next}&limit=1`,
      ),
      PL,
      {
        fetchFirstPage: async () => {
          throw new Error("must not re-fetch page 1 on cursor path");
        },
        continueFeed: async (p) => p.getContinuation(),
      },
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["v2"]);
    expect(b2.page.next).toBeNull();
  });

  test("unknown playlist -> 404 playlist_not_found (never 500)", async () => {
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}`),
      PL,
      {
        fetchPlaylist: async () => {
          throw new Error("Playlist not found");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("playlist_not_found");
  });

  test("timeout -> 504 upstream_timeout", async () => {
    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}`),
      PL,
      {
        fetchPlaylist: async () => {
          throw err;
        },
      },
    );
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
  });

  test("stale-on-error serves cached profile with warning", async () => {
    const deps = profileDeps([playlistVideo("v1", "V1")]);
    const primed = await (
      await handlePlaylist(
        req(`http://x/api/v1/playlists/${PL}?limit=1`),
        PL,
        deps,
      )
    ).json();
    cacheSet(
      `playlist:profile:v1:${PL}:1`,
      {
        profile: primed.data.playlist,
        items: primed.data.items,
        forkFrom: null,
      },
      -1,
      24 * 60 * 60 * 1000,
    );
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=1`),
      PL,
      {
        fetchPlaylist: async () => {
          const err = new Error("Upstream timed out after 8000ms");
          err.name = "TimeoutError";
          throw err;
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });

  test("definitive not-found never serves stale", async () => {
    const deps = profileDeps([playlistVideo("v1", "V1")]);
    const primed = await (
      await handlePlaylist(
        req(`http://x/api/v1/playlists/${PL}?limit=1`),
        PL,
        deps,
      )
    ).json();
    cacheSet(
      `playlist:profile:v1:${PL}:1`,
      {
        profile: primed.data.playlist,
        items: primed.data.items,
        forkFrom: null,
      },
      -1,
      24 * 60 * 60 * 1000,
    );
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=1`),
      PL,
      {
        fetchPlaylist: async () => {
          throw new Error("playlist_not_found: gone");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("playlist_not_found");
  });
});

describe("playlist items handler (mocked upstream)", () => {
  test("invalid id -> 400 invalid_playlist_id, upstream untouched", async () => {
    let called = false;
    const res = await handlePlaylistItems(
      req("http://x/api/v1/playlists/x!"),
      "x!",
      {
        fetchFirstPage: async () => {
          called = true;
          return fakeFeed([[]]);
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_playlist_id");
    expect(called).toBe(false);
  });

  test("invalid limit -> 400 invalid_limit", async () => {
    const res = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=many`),
      PL,
      itemsDeps([[playlistVideo("v1", "V1")]]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("first page maps DTOs with placeholders; cursor walks pages 2+", async () => {
    const deps = itemsDeps([
      [playlistVideo("v1", "V1"), deletedVideo(), privateVideo("pv1")],
      [playlistVideo("v2", "V2")],
    ]);
    const first = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=3`),
      PL,
      deps,
    );
    expect(first.status).toBe(200);
    const b1 = await first.json();
    // Placeholders are data, not drops: all 3 nodes map.
    expect(b1.data.map((d: { kind: string }) => d.kind)).toEqual([
      "video",
      "deleted",
      "private",
    ]);
    expect(typeof b1.page.next).toBe("string");
    expect(b1.meta.requestId).toBe("phase5");
    expect(first.headers.get("X-Request-Id")).toBe("phase5");
    expect(first.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");

    const second = await handlePlaylistItems(
      req(
        `http://x/api/v1/playlists/${PL}/items?cursor=${b1.page.next}&limit=3`,
      ),
      PL,
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["v2"]);
    expect(b2.page.next).toBeNull();
    expect(second.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("cursor walks >= 3 pages", async () => {
    const deps = itemsDeps([
      [playlistVideo("a", "A"), playlistVideo("b", "B")],
      [playlistVideo("c", "C")],
      [playlistVideo("d", "D"), playlistVideo("e", "E")],
    ]);
    const seen: string[] = [];
    let next: string | null = null;
    const first = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=2`),
        PL,
        deps,
      )
    ).json();
    seen.push(...first.data.map((d: { id: string }) => d.id));
    next = first.page.next;
    let pages = 1;
    while (next) {
      const body = await (
        await handlePlaylistItems(
          req(`http://x/api/v1/playlists/${PL}/items?cursor=${next}&limit=2`),
          PL,
          deps,
        )
      ).json();
      seen.push(...body.data.map((d: { id: string }) => d.id));
      next = body.page.next;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("100+ item playlists paginate end-to-end with stable ordering", async () => {
    const total = 120;
    const pages: Array<unknown[]> = [];
    for (let p = 0; p < 6; p += 1) {
      const items: unknown[] = [];
      for (let i = 0; i < 20; i += 1) {
        const n = p * 20 + i;
        items.push(playlistVideo(`v${n}`, `Video ${n}`, n + 1));
      }
      pages.push(items);
    }
    const deps = itemsDeps(pages);
    const seen: string[] = [];
    let next: string | null = null;
    const first = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=20`),
        PL,
        deps,
      )
    ).json();
    seen.push(...first.data.map((d: { id: string }) => d.id));
    next = first.page.next;
    while (next) {
      const body = await (
        await handlePlaylistItems(
          req(`http://x/api/v1/playlists/${PL}/items?cursor=${next}&limit=20`),
          PL,
          deps,
        )
      ).json();
      seen.push(...body.data.map((d: { id: string }) => d.id));
      next = body.page.next;
    }
    expect(seen).toHaveLength(total);
    expect(seen).toEqual(Array.from({ length: total }, (_v, n) => `v${n}`));
  });

  test("unknown cursor -> [] + next: null (never 404)", async () => {
    const res = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?cursor=nope`),
      PL,
      itemsDeps([[playlistVideo("v1", "V1")]]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("empty playlist -> 200 data:[] + next:null (never 404)", async () => {
    const res = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=5`),
      PL,
      itemsDeps([[]]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("exhausted first page keeps the public playlistFeed TTL", async () => {
    const res = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=5`),
      PL,
      itemsDeps([[playlistVideo("only", "Only")]]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
    expect((await res.json()).page.next).toBeNull();
  });

  test("cross-playlist cursor -> [] + next: null (never foreign items)", async () => {
    const deps = itemsDeps([
      [playlistVideo("v1", "V1"), playlistVideo("v2", "V2")],
      [playlistVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=2`),
        PL,
        deps,
      )
    ).json();
    const cross = await handlePlaylistItems(
      req(
        `http://x/api/v1/playlists/PLother0000000000000000000001/items?cursor=${b1.page.next}&limit=2`,
      ),
      "PLother0000000000000000000001",
      deps,
    );
    const body = await cross.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("cross-scope cursor (playlist items <-> channel playlists) rejected", async () => {
    const itemDeps = itemsDeps([
      [playlistVideo("v1", "V1"), playlistVideo("v2", "V2")],
      [playlistVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=2`),
        PL,
        itemDeps,
      )
    ).json();
    const plDeps = channelPlaylistsDeps([[gridPlaylist("PL1", "P1")]]);
    const cross = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      plDeps,
    );
    expect((await cross.json()).data).toEqual([]);

    const c1 = await (
      await handleChannelPlaylists(
        req(`http://x/api/v1/channels/${UC}/playlists?limit=1`),
        UC,
        channelPlaylistsDeps([
          [gridPlaylist("PL1", "P1"), gridPlaylist("PL2", "P2")],
          [gridPlaylist("PL3", "P3")],
        ]),
      )
    ).json();
    const back = await handlePlaylistItems(
      req(
        `http://x/api/v1/playlists/${PL}/items?cursor=${c1.page.next}&limit=1`,
      ),
      PL,
      itemDeps,
    );
    const backBody = await back.json();
    expect(backBody.data).toEqual([]);
    expect(backBody.page.next).toBeNull();
  });

  test("continuation fetch failure -> [] + continuation_failed warning", async () => {
    const deps = itemsDeps([
      [playlistVideo("v1", "V1"), playlistVideo("v2", "V2")],
      [playlistVideo("v3", "V3")],
    ]);
    const b1 = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=2`),
        PL,
        deps,
      )
    ).json();
    // Buffer holds exactly `limit` items with upstream continuation left, so
    // the cursor request must call continueFeed — which throws here.
    const res = await handlePlaylistItems(
      req(
        `http://x/api/v1/playlists/${PL}/items?cursor=${b1.page.next}&limit=2`,
      ),
      PL,
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

  test("playlist_not_found -> 404; timeout -> 504; generic -> 502", async () => {
    const nf = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items`),
      PL,
      {
        fetchFirstPage: async () => {
          throw new Error("playlist_not_found: PLx");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("playlist_not_found");

    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items`),
      PL,
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

    const bad = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items`),
      PL,
      {
        fetchFirstPage: async () => {
          throw new Error("upstream down");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).error.code).toBe("upstream_degraded");
  });

  test("stale-on-error serves items with warning; not-found never serves stale", async () => {
    const deps = itemsDeps([[playlistVideo("v1", "V1")]]);
    const primed = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
        PL,
        deps,
      )
    ).json();
    cacheSet(
      `playlist:items:v1:${PL}:1`,
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
      PL,
      {
        ...deps,
        fetchFirstPage: async () => {
          const err = new Error("Upstream timed out after 8000ms");
          err.name = "TimeoutError";
          throw err;
        },
      },
    );
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.data).toEqual(primed.data);
    expect(staleBody.meta.cached).toBe(true);
    expect(staleBody.warnings[0].code).toBe("stale_served");

    const nf = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
      PL,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("playlist_not_found: gone");
        },
      },
    );
    expect(nf.status).toBe(404);
  });
});

describe("stale-retry gate at the handlers (transient only)", () => {
  test("unviewable playlist -> 404 playlist_not_found (never 502)", async () => {
    const res = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items`),
      PL,
      {
        fetchFirstPage: async () => {
          throw new Error("This playlist type is unviewable.");
        },
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("playlist_not_found");
  });

  test("429 refresh failure serves stale; 403 surfaces the error", async () => {
    const deps = itemsDeps([[playlistVideo("v1", "V1")]]);
    const primed = await (
      await handlePlaylistItems(
        req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
        PL,
        deps,
      )
    ).json();
    cacheSet(
      `playlist:items:v1:${PL}:1`,
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const limited = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
      PL,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("Request failed with status code 429");
        },
      },
    );
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json();
    expect(limitedBody.data).toEqual(primed.data);
    expect(limitedBody.warnings[0].code).toBe("stale_served");

    const forbidden = await handlePlaylistItems(
      req(`http://x/api/v1/playlists/${PL}/items?limit=1`),
      PL,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("Request failed with status code 403");
        },
      },
    );
    expect(forbidden.status).toBe(502);
    const forbiddenBody = await forbidden.json();
    expect(forbiddenBody.error.code).toBe("upstream_degraded");
  });

  test("unviewable never serves stale on the profile route", async () => {
    const deps = profileDeps([playlistVideo("v1", "V1")]);
    const primed = await (
      await handlePlaylist(
        req(`http://x/api/v1/playlists/${PL}?limit=1`),
        PL,
        deps,
      )
    ).json();
    cacheSet(
      `playlist:profile:v1:${PL}:1`,
      {
        profile: primed.data.playlist,
        items: primed.data.items,
        forkFrom: null,
      },
      -1,
      24 * 60 * 60 * 1000,
    );
    const res = await handlePlaylist(
      req(`http://x/api/v1/playlists/${PL}?limit=1`),
      PL,
      {
        fetchPlaylist: async () => {
          throw new Error("This playlist type is unviewable.");
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("playlist_not_found");
  });
});

describe("channel playlists handler (mocked upstream)", () => {
  test("invalid channel id -> 400 invalid_channel_id, upstream untouched", async () => {
    let called = false;
    const res = await handleChannelPlaylists(
      req("http://x/api/v1/channels/x"),
      "x",
      {
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
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_channel_id");
    expect(called).toBe(false);
  });

  test("first page maps DTOs, mints cursor; cursor walks page 2", async () => {
    const deps = channelPlaylistsDeps([
      [gridPlaylist("PL1", "P1"), otherVideoNode, lockupPlaylist("PL2")],
      [gridPlaylist("PL3", "P3")],
    ]);
    const first = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=3`),
      UC,
      deps,
    );
    expect(first.status).toBe(200);
    const b1 = await first.json();
    // The video node sits inside the limit slice but is dropped by the
    // playlist-only guard (never counted as data).
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual(["PL1", "PL2"]);
    expect(typeof b1.page.next).toBe("string");
    expect(first.headers.get("X-Request-Id")).toBe("phase5");
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");

    const second = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${b1.page.next}&limit=3`,
      ),
      UC,
      deps,
    );
    const b2 = await second.json();
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["PL3"]);
    expect(b2.page.next).toBeNull();
  });

  test("missing shelf (no playlists tab) -> terminal empty page", async () => {
    const res = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=5`),
      UC,
      {
        resolveChannelId: async (i) => i,
        fetchFirstPage: async (_id) => emptyPlaylistFeed(),
        continueFeed: async () => {
          throw new Error("unreached");
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
  });

  test("handle and UC form share scope, cache, and cursors (resolved UC id)", async () => {
    const deps = channelPlaylistsDeps(
      [
        [gridPlaylist("PL1", "P1"), gridPlaylist("PL2", "P2")],
        [gridPlaylist("PL3", "P3")],
      ],
      async (input) => (input.startsWith("@") ? UC : input),
    );
    const b1 = await (
      await handleChannelPlaylists(
        req(`http://x/api/v1/channels/@SomeHandle/playlists?limit=2`),
        "@SomeHandle",
        deps,
      )
    ).json();
    expect(typeof b1.page.next).toBe("string");
    const second = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${b1.page.next}&limit=2`,
      ),
      UC,
      deps,
    );
    expect((await second.json()).data.map((d: { id: string }) => d.id)).toEqual(
      ["PL3"],
    );
    const ucFirst = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=2`),
      UC,
      deps,
    );
    const ucBody = await ucFirst.json();
    expect(ucBody.meta.cached).toBe(true);
    // Both address forms behave identically: same items, and both mint a
    // page-1 cursor (the live skew came from the empty videos-memo adapter
    // + upstream has_continuation flip-flops, now fixed at the source).
    expect(ucBody.data).toEqual(b1.data);
    expect(typeof ucBody.page.next).toBe("string");
  });

  test("unknown cursor -> [] + next: null; cross-channel rejected", async () => {
    const deps = channelPlaylistsDeps([
      [gridPlaylist("PL1", "P1"), gridPlaylist("PL2", "P2")],
      [gridPlaylist("PL3", "P3")],
    ]);
    const unknown = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?cursor=nope`),
      UC,
      deps,
    );
    expect((await unknown.json()).data).toEqual([]);

    const b1 = await (
      await handleChannelPlaylists(
        req(`http://x/api/v1/channels/${UC}/playlists?limit=2`),
        UC,
        deps,
      )
    ).json();
    const other = "UC_AAAAAAAAAAAAAAAAAAAAAAAA";
    const cross = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${other}/playlists?cursor=${b1.page.next}&limit=2`,
      ),
      other,
      deps,
    );
    const body = await cross.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("continuation fetch failure -> [] + continuation_failed warning", async () => {
    const deps = channelPlaylistsDeps([
      [gridPlaylist("PL1", "P1"), gridPlaylist("PL2", "P2")],
      [gridPlaylist("PL3", "P3")],
    ]);
    const b1 = await (
      await handleChannelPlaylists(
        req(`http://x/api/v1/channels/${UC}/playlists?limit=2`),
        UC,
        deps,
      )
    ).json();
    const res = await handleChannelPlaylists(
      req(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${b1.page.next}&limit=2`,
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

  test("channel_not_found -> 404; timeout -> 504; stale-on-error works", async () => {
    const deps = channelPlaylistsDeps([[gridPlaylist("PL1", "P1")]]);
    const nf = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=1`),
      UC,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw new Error("channel_not_found: gone");
        },
      },
    );
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("channel_not_found");

    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    const to = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=1`),
      UC,
      {
        ...deps,
        fetchFirstPage: async () => {
          throw err;
        },
      },
    );
    expect(to.status).toBe(504);

    const primed = await (
      await handleChannelPlaylists(
        req(`http://x/api/v1/channels/${UC}/playlists?limit=1`),
        UC,
        deps,
      )
    ).json();
    cacheSet(
      `channel:playlists:v1:${UC}:1`,
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handleChannelPlaylists(
      req(`http://x/api/v1/channels/${UC}/playlists?limit=1`),
      UC,
      {
        ...deps,
        fetchFirstPage: async () => {
          const err = new Error("Upstream timed out after 8000ms");
          err.name = "TimeoutError";
          throw err;
        },
      },
    );
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.data).toEqual(primed.data);
    expect(staleBody.meta.cached).toBe(true);
    expect(staleBody.warnings[0].code).toBe("stale_served");
  });
});

describe("openapi phase 5", () => {
  test("lists the 3 playlist paths with params and typed responses", () => {
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
      "/playlists/{id}",
      "/playlists/{id}/items",
      "/channels/{id}/playlists",
    ]) {
      expect(Object.keys(paths)).toContain(p);
    }
    expect(paths["/playlists/{id}"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining(["id", "limit", "region", "lang"]),
    );
    for (const p of ["/playlists/{id}/items", "/channels/{id}/playlists"]) {
      expect(paths[p].get.parameters.map((q) => q.name)).toEqual(
        expect.arrayContaining(["id", "limit", "cursor", "region", "lang"]),
      );
      const codes = Object.keys(paths[p].get.responses);
      for (const c of ["200", "400", "404", "429", "502", "504"]) {
        expect(codes).toContain(c);
      }
    }
    expect(Object.keys(paths["/playlists/{id}"].get.responses)).toContain(
      "404",
    );
    // Phase 4 paths still documented (no drift).
    for (const p of ["/channels/{id}", "/channels/{id}/videos"]) {
      expect(Object.keys(paths)).toContain(p);
    }
  });
});
