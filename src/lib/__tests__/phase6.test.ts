import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleArtist } from "../../app/api/v1/artists/[id]/route";
import { handleMusicCharts } from "../../app/api/v1/music/charts/route";
import { handleMusicSearch } from "../../app/api/v1/music/search/route";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import { cacheSet, clearCache } from "../cache";
import { clearContinuations, storeContinuation } from "../continuations";
import {
  adaptMusicSearch,
  extractChartShelves,
  type MusicSearchPage,
  mapArtistProfile,
  mapChartSections,
  mapMusicItem,
  parseArtistId,
  parseCountry,
  parseMusicChartsParams,
  parseMusicSearchParams,
} from "../music";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

function req(url: string, requestId = "phase6"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

/** Fake immutable music-search pages (mirrors Search.getContinuation). */
function fakeSearchPage(
  rows: unknown[],
  hasMore = false,
  next: MusicSearchPage | null = null,
): MusicSearchPage {
  return {
    results: rows,
    has_continuation: hasMore,
    getContinuation: async () => next ?? fakeSearchPage([], false),
  };
}

const thumb = { contents: [{ url: "https://i/thumb", width: 60, height: 60 }] };

const songRow = (id: string, title: string) => ({
  type: "MusicResponsiveListItem",
  id,
  item_type: "song",
  flex_columns: [
    {
      title: {
        text: title,
        endpoint: {
          payload: {
            videoId: id,
            watchEndpointMusicSupportedConfigs: {
              watchEndpointMusicConfig: {
                musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
              },
            },
          },
        },
      },
    },
    {
      title: {
        runs: [
          {
            text: "Some Artist",
            endpoint: { payload: { browseId: "UC_someartist0000000001" } },
          },
          { text: " • " },
          {
            text: "Some Album",
            endpoint: { payload: { browseId: "MPRE_somealbum00001" } },
          },
          { text: " • " },
          { text: "3:45" },
        ],
      },
    },
  ],
  duration: { text: "3:45" },
  thumbnail: thumb,
});

const videoRow = (id: string) => ({
  type: "MusicResponsiveListItem",
  id,
  flex_columns: [
    {
      title: {
        text: "Official Video",
        endpoint: { payload: { videoId: id } },
      },
    },
  ],
  thumbnail: thumb,
});

const artistRow = (id: string, name: string) => ({
  type: "MusicResponsiveListItem",
  id,
  item_type: "artist",
  flex_columns: [{ title: { text: name } }],
  endpoint: { payload: { browseId: id } },
  thumbnail: thumb,
});

const albumCard = (id: string, title: string, subtitle: string) => ({
  type: "MusicTwoRowItem",
  id,
  title: { text: title },
  subtitle: { text: subtitle },
  endpoint: { payload: { browseId: id } },
  thumbnail: thumb,
});

const unsupportedRow = { type: "AdSlot", id: "ad1" };

const UC = "UCRw0x9_EfawqmgDI2IgQLLg";

const artistPayload = () => ({
  header: {
    type: "MusicImmersiveHeader",
    title: { text: "Adele" },
    description: "375M monthly audience",
    thumbnail: thumb,
  },
  sections: [
    {
      type: "MusicShelf",
      title: { text: "Top songs" },
      contents: [songRow("vid1", "Rolling in the Deep"), videoRow("vid2")],
    },
    {
      type: "MusicCarouselShelf",
      title: { text: "Albums" },
      contents: [albumCard("MPRE_album00000000001", "30", "Album • 2021")],
    },
    {
      type: "MusicCarouselShelf",
      title: { text: "Singles & EPs" },
      contents: [
        albumCard("MPRE_single0000000001", "Easy On Me", "Single • 2021"),
      ],
    },
    {
      type: "MusicCarouselShelf",
      title: { text: "Fans might also like" },
      contents: [artistRow("UC_other00000000000001", "Other Artist")],
    },
  ],
});

const chartsRaw = () => ({
  tabs: [
    {
      selected: true,
      content: {
        contents: [
          // Lazily-filled top-songs shelf: no title, no rows -> skipped.
          { type: "MusicShelf" },
          {
            type: "MusicCarouselShelf",
            title: { text: "Top artists" },
            contents: [
              artistRow("UC_top1000000000000001", "Top Artist"),
              artistRow("UC_top2000000000000001", "Second Artist"),
            ],
          },
          {
            type: "MusicCarouselShelf",
            title: { text: "Video charts" },
            contents: [
              albumCard(
                "VLPLchart00000000000001",
                "Top 100 Songs - United States",
                "Chart • YouTube Music",
              ),
            ],
          },
        ],
      },
    },
  ],
});

const searchDeps = (rows: unknown[], hasMore = false) => ({
  runSearch: async () => fakeSearchPage(rows, hasMore),
  continueSearch: async (page: MusicSearchPage) => page.getContinuation(),
});

describe("music search validation", () => {
  test("missing q is a 400 missing_query", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search"),
      searchDeps([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("missing_query");
  });

  test("unknown type is a 400 invalid_type", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=lofi&type=podcast"),
      searchDeps([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_type");
  });

  test("non-integer limit is a 400 invalid_limit", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=lofi&limit=abc"),
      searchDeps([]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_limit");
  });

  test("cursor request with bad limit is a 400", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search?cursor=nope&limit=huge"),
      searchDeps([]),
    );
    expect(res.status).toBe(400);
  });

  test("pure parser covers q/type/limit/region/lang", () => {
    expect(parseMusicSearchParams(new URLSearchParams("q=a")).ok).toBe(true);
    const bad = parseMusicSearchParams(new URLSearchParams("q=a&type=nope"));
    expect(bad.ok).toBe(false);
    expect(parseCountry("gb")).toBe("GB");
    expect(parseCountry("xx!")).toBe("US");
    expect(parseCountry(null)).toBe("US");
    const charts = parseMusicChartsParams(new URLSearchParams("country=de"));
    expect(charts.ok && charts.value.country).toBe("DE");
    expect(parseArtistId(UC).ok).toBe(true);
    expect(parseArtistId("MPRE_abc").ok).toBe(false);
  });
});

describe("music search results", () => {
  test("items are typed with a kind discriminator; unknown nodes dropped", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=lofi&limit=10"),
      searchDeps([
        songRow("vid1", "Song A"),
        albumCard("MPRE_album00000000001", "Album A", "Album • 2021"),
        artistRow("UC_artist0000000000001", "Artist A"),
        videoRow("vid9"),
        unsupportedRow,
      ]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: { kind: string }) => d.kind)).toEqual([
      "song",
      "album",
      "artist",
      "video",
    ]);
    const song = body.data[0];
    expect(song.artists[0]).toEqual({
      id: "UC_someartist0000000001",
      name: "Some Artist",
    });
    expect(song.album).toEqual({
      id: "MPRE_somealbum00001",
      title: "Some Album",
    });
    expect(song.durationSeconds).toBe(225);
    expect(body.page.next).toBeNull();
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
  });

  test("cursor pages are no-store and walk the buffer", async () => {
    const rows = [songRow("v1", "A"), songRow("v2", "B"), songRow("v3", "C")];
    const first = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=lofi&limit=2"),
      searchDeps(rows),
    );
    const firstBody = await first.json();
    expect(firstBody.data.map((d: { id: string }) => d.id)).toEqual([
      "v1",
      "v2",
    ]);
    expect(typeof firstBody.page.next).toBe("string");
    expect(first.headers.get("cache-control")).toBe("private, no-store");

    const second = await handleMusicSearch(
      req(
        `http://x/api/v1/music/search?cursor=${firstBody.page.next}&limit=2&region=de&lang=fr`,
      ),
      searchDeps(rows),
    );
    const secondBody = await second.json();
    expect(secondBody.data.map((d: { id: string }) => d.id)).toEqual(["v3"]);
    expect(secondBody.page.next).toBeNull();
    expect(secondBody.meta).toMatchObject({ region: "DE", lang: "fr" });
    expect(second.headers.get("cache-control")).toBe("private, no-store");
  });

  test("unknown cursor yields an empty page, never an error", async () => {
    const res = await handleMusicSearch(
      req("http://x/api/v1/music/search?cursor=ghost"),
      searchDeps([]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("foreign-scope cursor yields an empty page", async () => {
    const foreign = storeContinuation(
      {
        results: [songRow("v1", "A")],
        has_continuation: false,
        getContinuation: async () => {
          throw new Error("unused");
        },
      },
      0,
      "search",
    );
    const res = await handleMusicSearch(
      req(`http://x/api/v1/music/search?cursor=${foreign}`),
      searchDeps([]),
    );
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("upstream timeout is a 504, generic failure a 502", async () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    const to = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=a"),
      {
        ...searchDeps([]),
        runSearch: async () => {
          throw timeout;
        },
      },
    );
    expect(to.status).toBe(504);
    expect((await to.json()).error.code).toBe("upstream_timeout");

    const down = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=a"),
      {
        ...searchDeps([]),
        runSearch: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(down.status).toBe(502);
  });

  test("continuation fetch failure is a typed error, not an empty page", async () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    const deps = {
      runSearch: async () =>
        fakeSearchPage([songRow("v1", "A"), songRow("v2", "B")], true),
      continueSearch: async () => {
        throw timeout;
      },
    };
    const first = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=a&limit=2"),
      deps,
    );
    const cursor = (await first.json()).page.next as string;
    const second = await handleMusicSearch(
      req(`http://x/api/v1/music/search?cursor=${cursor}&limit=2`),
      deps,
    );
    expect(second.status).toBe(504);
    expect((await second.json()).error.code).toBe("upstream_timeout");
  });

  test("stale-on-error serves cached page with cached:true + warnings", async () => {
    const primed = await (
      await handleMusicSearch(
        req("http://x/api/v1/music/search?q=lofi&limit=1"),
        searchDeps([songRow("v1", "A")]),
      )
    ).json();
    cacheSet(
      "music-search:v1:US:en:all:1:lofi",
      { items: primed.data, forkFrom: null },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handleMusicSearch(
      req("http://x/api/v1/music/search?q=lofi&limit=1"),
      {
        ...searchDeps([]),
        runSearch: async () => {
          const err = new Error("Upstream timed out after 8000ms");
          err.name = "TimeoutError";
          throw err;
        },
      },
    );
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });
});

describe("music charts", () => {
  test("shelves parse into titled sections; hollow shelves skipped", async () => {
    const res = await handleMusicCharts(req("http://x/api/v1/music/charts"), {
      fetchCharts: async () => chartsRaw(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.country).toBe("US");
    expect(body.data.sections.map((s: { title: string }) => s.title)).toEqual([
      "Top artists",
      "Video charts",
    ]);
    expect(body.data.sections[0].items[0].kind).toBe("artist");
    expect(body.data.sections[1].items[0].kind).toBe("playlist");
    expect(body.page.next).toBeNull();
    expect(body.warnings).toEqual([]);
    expect(res.headers.get("cache-control")).toContain("s-maxage=600");
    expect(res.headers.get("x-request-id")).toBe("phase6");
  });

  test("non-US country echoes with a country_fallback warning", async () => {
    const res = await handleMusicCharts(
      req("http://x/api/v1/music/charts?country=de"),
      { fetchCharts: async () => chartsRaw() },
    );
    const body = await res.json();
    expect(body.data.country).toBe("DE");
    expect(body.warnings[0].code).toBe("country_fallback");
  });

  test("empty upstream yields data sections:[] + next:null, never 404", async () => {
    const res = await handleMusicCharts(req("http://x/api/v1/music/charts"), {
      fetchCharts: async () => ({ tabs: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sections).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("upstream failure is a 502, timeout a 504; bad limit a 400", async () => {
    const down = await handleMusicCharts(req("http://x/api/v1/music/charts"), {
      fetchCharts: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(down.status).toBe(502);

    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    const to = await handleMusicCharts(req("http://x/api/v1/music/charts"), {
      fetchCharts: async () => {
        throw timeout;
      },
    });
    expect(to.status).toBe(504);

    const bad = await handleMusicCharts(
      req("http://x/api/v1/music/charts?limit=nope"),
      { fetchCharts: async () => chartsRaw() },
    );
    expect(bad.status).toBe(400);
  });

  test("stale-on-error serves cached snapshot with cached:true", async () => {
    const primed = await (
      await handleMusicCharts(req("http://x/api/v1/music/charts"), {
        fetchCharts: async () => chartsRaw(),
      })
    ).json();
    cacheSet(
      "music-charts:v1:US:20",
      { sections: primed.data.sections },
      -1,
      60 * 60 * 1000,
    );
    const stale = await handleMusicCharts(req("http://x/api/v1/music/charts"), {
      fetchCharts: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data.sections).toEqual(primed.data.sections);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");
  });
});

describe("artists", () => {
  test("profile returns identity plus top songs and albums", async () => {
    const res = await handleArtist(req(`http://x/api/v1/artists/${UC}`), UC, {
      fetchArtist: async () => artistPayload(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(UC);
    expect(body.data.name).toBe("Adele");
    expect(body.data.subscriberCount).toBe(375_000_000);
    expect(body.data.topSongs.map((s: { title: string }) => s.title)).toEqual([
      "Rolling in the Deep",
      "Official Video",
    ]);
    expect(body.data.albums.map((a: { title: string }) => a.title)).toEqual([
      "30",
      "Easy On Me",
    ]);
    expect(body.data.albums[0].year).toBe("2021");
    expect(body.page.next).toBeNull();
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
  });

  test("non-UC id is a 400 and never touches upstream", async () => {
    let called = false;
    const res = await handleArtist(
      req("http://x/api/v1/artists/MPRE_abc"),
      "MPRE_abc",
      {
        fetchArtist: async () => {
          called = true;
          return {};
        },
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_artist_id");
    expect(called).toBe(false);
  });

  test("unknown artist is a 404 artist_not_found", async () => {
    const missing = await handleArtist(
      req(`http://x/api/v1/artists/${UC}`),
      UC,
      {
        fetchArtist: async () => {
          throw new Error("Artist not found: 404");
        },
      },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("artist_not_found");

    const hollow = await handleArtist(
      req(`http://x/api/v1/artists/${UC}`),
      UC,
      {
        fetchArtist: async () => ({}),
      },
    );
    expect(hollow.status).toBe(404);
  });

  test("timeout is a 504, generic failure a 502", async () => {
    const timeout = new Error("Upstream timed out after 8000ms");
    timeout.name = "TimeoutError";
    const to = await handleArtist(req(`http://x/api/v1/artists/${UC}`), UC, {
      fetchArtist: async () => {
        throw timeout;
      },
    });
    expect(to.status).toBe(504);

    const down = await handleArtist(req(`http://x/api/v1/artists/${UC}`), UC, {
      fetchArtist: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(down.status).toBe(502);
  });

  test("stale-on-error serves cached profile; not-found never serves stale", async () => {
    const primed = await (
      await handleArtist(req(`http://x/api/v1/artists/${UC}`), UC, {
        fetchArtist: async () => artistPayload(),
      })
    ).json();
    cacheSet(`artist:v1:${UC}`, primed.data, -1, 60 * 60 * 1000);
    const stale = await handleArtist(req(`http://x/api/v1/artists/${UC}`), UC, {
      fetchArtist: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(stale.status).toBe(200);
    const body = await stale.json();
    expect(body.data).toEqual(primed.data);
    expect(body.meta.cached).toBe(true);
    expect(body.warnings[0].code).toBe("stale_served");

    const notFound = await handleArtist(
      req(`http://x/api/v1/artists/${UC}`),
      UC,
      {
        fetchArtist: async () => {
          throw new Error("artist not found");
        },
      },
    );
    expect(notFound.status).toBe(404);
  });
});

describe("pure music mappers", () => {
  test("mapMusicItem kinds + adaptMusicSearch flatten + chart extraction", async () => {
    expect(mapMusicItem(unsupportedRow)).toBeNull();
    expect(mapMusicItem(null)).toBeNull();
    expect(
      mapMusicItem(albumCard("MPRE_x00000000000001", "T", "S"))?.kind,
    ).toBe("album");
    expect(mapMusicItem(artistRow("UC_x00000000000000001", "N"))?.kind).toBe(
      "artist",
    );
    expect(mapMusicItem(videoRow("vid9"))?.kind).toBe("video");
    expect(mapMusicItem(songRow("vid1", "S"))?.kind).toBe("song");
    // A card with no recognizable endpoint/item_type is dropped, never
    // invented as a playlist.
    expect(
      mapMusicItem({ type: "MusicTwoRowItem", id: "mystery1", title: "?" }),
    ).toBeNull();

    const adapted = adaptMusicSearch({
      contents: [
        { type: "MusicShelf", contents: [songRow("a", "A")] },
        { type: "MusicShelf", contents: [songRow("b", "B")] },
      ],
      has_continuation: true,
      getContinuation: async () => ({
        contents: [{ type: "MusicShelf", contents: [songRow("c", "C")] }],
        has_continuation: false,
        getContinuation: async () => ({}),
      }),
    });
    expect(adapted.results).toHaveLength(2);
    expect(adapted.has_continuation).toBe(true);
    const next = await adapted.getContinuation();
    expect(next.results).toHaveLength(1);

    expect(extractChartShelves({ tabs: [] })).toEqual([]);
    expect(extractChartShelves(null)).toEqual([]);
    expect(mapChartSections([], 20)).toEqual([]);
    expect(mapArtistProfile(null, UC)).toBeNull();
    expect(mapArtistProfile({}, undefined)).toBeNull();
  });
});

describe("openapi phase 6", () => {
  test("lists the 3 music paths with params, operationIds, typed responses", () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as unknown as Record<
      string,
      {
        get: {
          operationId: string;
          parameters: Array<{ name: string }>;
          responses: Record<string, unknown>;
        };
      }
    >;
    for (const p of ["/music/search", "/music/charts", "/artists/{id}"]) {
      expect(Object.keys(paths)).toContain(p);
    }
    expect(paths["/music/search"].get.operationId).toBe("searchMusic");
    expect(paths["/music/charts"].get.operationId).toBe("getMusicCharts");
    expect(paths["/artists/{id}"].get.operationId).toBe("getArtist");
    expect(paths["/music/search"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining([
        "q",
        "type",
        "limit",
        "cursor",
        "region",
        "lang",
      ]),
    );
    expect(paths["/music/charts"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining(["country", "limit", "region", "lang"]),
    );
    expect(paths["/artists/{id}"].get.parameters.map((q) => q.name)).toEqual(
      expect.arrayContaining(["id", "region", "lang"]),
    );
    for (const p of ["/music/search", "/music/charts", "/artists/{id}"]) {
      const codes = Object.keys(paths[p].get.responses);
      for (const c of ["200", "429", "502", "504"]) {
        expect(codes).toContain(c);
      }
    }
    expect(Object.keys(paths["/artists/{id}"].get.responses)).toContain("404");
    // Earlier phases still documented (no drift).
    for (const p of ["/search", "/playlists/{id}", "/channels/{id}"]) {
      expect(Object.keys(paths)).toContain(p);
    }
  });
});
