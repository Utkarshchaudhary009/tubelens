// Phase 6 (Music) pure helpers: validation, DTO mappers, error classifiers,
// and upstream-shape adapters for the YouTube Music–native endpoints.
// All access is tolerant `Record<string, unknown>` reads (node shapes vary
// across youtubei.js clients); unknown nodes map to null and are dropped by
// callers. No imports from lib/youtube so this stays unit-testable without
// network.
//
// Live shapes (verified 2026-09-09 against youtubei.js 18.0.0):
// - `innertube.music.search(q, filters?)` -> Search { header, contents }.
//   contents is an ObservedArray of MusicShelf nodes (one per filter, e.g.
//   "Songs"); each shelf holds MusicResponsiveListItem rows. Continuation
//   returns the same shape via getContinuation().
// - `innertube.music.getArtist(UC-id)` -> { header: MusicImmersiveHeader,
//   sections: [MusicShelf "Top songs", MusicCarouselShelf "Albums", ...] }.
// - Charts has NO typed client: raw browse { browseId: "FEmusic_charts",
//   params: "sgYPRkVtdXNpY19leHBsb3Jl", client: "YTMUSIC", parse: true }
//   -> SingleColumnBrowseResults -> tabs[0].content (SectionList) -> shelves
//   (MusicShelf / MusicCarouselShelf). The leading top-songs MusicShelf
//   arrives with empty contents on first paint, so empty untitled shelves are
//   skipped rather than served as hollow sections (never fabricated).

import { parseDurationText } from "@/lib/channels";
import { type Thumbnail, textOf } from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

// ---------------------------------------------------------------------------
// Query/path validation.
// ---------------------------------------------------------------------------

export const MUSIC_SEARCH_TYPES = [
  "song",
  "album",
  "artist",
  "video",
  "playlist",
  "all",
] as const;

export type MusicSearchType = (typeof MUSIC_SEARCH_TYPES)[number];

export interface MusicSearchParams {
  q: string;
  type: MusicSearchType;
  limit: number;
  region: string;
  lang: string;
}

export interface MusicParamsError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export type MusicSearchParamsResult =
  | { ok: true; value: MusicSearchParams }
  | { ok: false; error: MusicParamsError };

/**
 * Pure validation for /api/v1/music/search query params. Missing q reuses
 * the search missing_query shape; unknown type is a 400 invalid_type (never
 * passed through — youtubei has no "all" filter, unfiltered = no filter).
 */
export function parseMusicSearchParams(
  params: URLSearchParams,
): MusicSearchParamsResult {
  const q = (params.get("q") ?? "").trim();
  if (!q) {
    return {
      ok: false,
      error: {
        code: "missing_query",
        message: "Query parameter q is required.",
        hint: "Add ?q= to your request, e.g. /api/v1/music/search?q=lofi.",
        status: 400,
      },
    };
  }
  const typeRaw = params.get("type") ?? "all";
  if (!MUSIC_SEARCH_TYPES.includes(typeRaw as MusicSearchType)) {
    return {
      ok: false,
      error: {
        code: "invalid_type",
        message: `Invalid type "${typeRaw}".`,
        hint: "Use one of: song, album, artist, video, playlist, all.",
        status: 400,
      },
    };
  }
  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return {
      ok: false,
      error: {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50; defaults to 20.",
        status: 400,
      },
    };
  }
  return {
    ok: true,
    value: {
      q,
      type: typeRaw as MusicSearchType,
      limit,
      region: parseRegion(params.get("region")),
      lang: parseLang(params.get("lang")),
    },
  };
}

export interface MusicChartsParams {
  country: string;
  limit: number;
  region: string;
  lang: string;
}

export type MusicChartsParamsResult =
  | { ok: true; value: MusicChartsParams }
  | { ok: false; error: MusicParamsError };

/**
 * Pure validation for /api/v1/music/charts query params. Country follows the
 * region echo-only convention (2-letter code, falls back to US when
 * absent/invalid — never a 400): the shared upstream session is fixed to
 * US/en, so non-US values are served the default snapshot with a
 * country_fallback warning rather than fabricated per-country data.
 */
export function parseMusicChartsParams(
  params: URLSearchParams,
): MusicChartsParamsResult {
  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return {
      ok: false,
      error: {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50; defaults to 20.",
        status: 400,
      },
    };
  }
  return {
    ok: true,
    value: {
      country: parseCountry(params.get("country")),
      limit,
      region: parseRegion(params.get("region")),
      lang: parseLang(params.get("lang")),
    },
  };
}

/** Two-letter country, uppercased; falls back to US when absent/invalid. */
export function parseCountry(raw: string | null): string {
  const v = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : "US";
}

export type ArtistIdResult =
  | { ok: true; value: string }
  | { ok: false; error: MusicParamsError };

const STRICT_ARTIST_ID = /^UC[A-Za-z0-9_-]{20,}$/;

/**
 * Pure validation for /api/v1/artists/:id path params. YouTube Music artist
 * ids are UC-prefixed channel ids (getArtist requires the UC form) — anything
 * else is a 400 invalid_artist_id, never a 502.
 */
export function parseArtistId(raw: string): ArtistIdResult {
  const value = (raw ?? "").trim();
  if (STRICT_ARTIST_ID.test(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: {
      code: "invalid_artist_id",
      message: "Invalid artist id.",
      hint: "Use a UC artist id (e.g. /api/v1/artists/UCRw0x9_EfawqmgDI2IgQLLg). Find ids via /api/v1/music/search?type=artist.",
      status: 400,
    },
  };
}

// ---------------------------------------------------------------------------
// Small tolerant readers (mirror the defensive style of lib/mappers).
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? "");
}

function normalizeThumbs(v: unknown): Thumbnail[] | undefined {
  const list = Array.isArray(v)
    ? v
    : ((asRecord(v)?.contents as unknown) ?? asRecord(v)?.thumbnails);
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: Thumbnail[] = [];
  for (const t of list) {
    const o = asRecord(t);
    if (!o || typeof o.url !== "string") {
      continue;
    }
    const thumb: Thumbnail = { url: o.url };
    if (typeof o.width === "number") {
      thumb.width = o.width;
    }
    if (typeof o.height === "number") {
      thumb.height = o.height;
    }
    out.push(thumb);
  }
  return out.length > 0 ? out : undefined;
}

/** Compact counts as served in audience/subscriber text: "375M", "15.7M". */
function parseCountText(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  const text = textOf(v);
  if (!text) {
    return undefined;
  }
  const compact = text.replace(/,/g, "").match(/([\d.]+)\s*([KMB])\b/i);
  if (compact?.[1] && compact?.[2]) {
    const base = Number(compact[1]);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[
      compact[2].toUpperCase() as "K" | "M" | "B"
    ];
    if (Number.isFinite(base) && mult !== undefined) {
      return base * mult;
    }
    return undefined;
  }
  const digits = text.replace(/,/g, "").match(/[\d.]+/);
  if (!digits?.[0]) {
    return undefined;
  }
  const n = Number(digits[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** Spread an ObservedArray/iterable defensively; non-iterables -> []. */
function spreadChildren(v: unknown): unknown[] {
  if (v === null || v === undefined) {
    return [];
  }
  if (Array.isArray(v)) {
    return [...v];
  }
  if (
    typeof v === "object" &&
    typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  ) {
    try {
      return [...(v as Iterable<unknown>)];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Music item DTO (shared by search + charts sections).
// ---------------------------------------------------------------------------

export type MusicKind = "song" | "album" | "artist" | "video" | "playlist";

export interface MusicItemDTO {
  id: string;
  /** Discriminator: song vs album vs artist vs video vs playlist. */
  kind: MusicKind;
  title: string;
  artists?: Array<{ id?: string; name: string }>;
  album?: { id?: string; title?: string };
  durationSeconds?: number;
  subtitle?: string;
  thumbnails?: Thumbnail[];
}

function kindFromEndpoint(
  endpoint: Record<string, unknown> | null,
): MusicKind | null {
  const payload = asRecord(endpoint?.payload);
  if (!payload) {
    return null;
  }
  if (typeof payload.videoId === "string" && payload.videoId !== "") {
    // Card nodes rarely carry a watch endpoint; when they do, the
    // list-branch refines song vs video via the ATV musicVideoType.
    return "video";
  }
  const browseId =
    typeof payload.browseId === "string" ? payload.browseId : undefined;
  if (!browseId) {
    if (typeof payload.playlistId === "string" && payload.playlistId !== "") {
      return "playlist";
    }
    return null;
  }
  if (browseId.startsWith("MPRE")) {
    return "album";
  }
  if (browseId.startsWith("UC")) {
    return "artist";
  }
  if (
    browseId.startsWith("VL") ||
    browseId.startsWith("PL") ||
    browseId.startsWith("RD") ||
    browseId.startsWith("OLAK")
  ) {
    return "playlist";
  }
  return null;
}

/** endpoint.payload browseId for browse endpoints, videoId for watch ones. */
function endpointId(
  endpoint: Record<string, unknown> | null,
): string | undefined {
  const payload = asRecord(endpoint?.payload);
  if (!payload) {
    return undefined;
  }
  for (const key of ["videoId", "browseId", "playlistId"]) {
    const v = payload[key];
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  return undefined;
}

interface RunCredits {
  artists: Array<{ id?: string; name: string }>;
  album?: { id?: string; title?: string };
}

/**
 * Classifies endpoint-bearing runs from secondary flex columns: UC runs are
 * artists, the first MPRE run is the album. Separator runs (" • ") carry no
 * endpoint and are skipped.
 */
function mapRunCredits(runs: unknown): RunCredits {
  const out: RunCredits = { artists: [] };
  if (!Array.isArray(runs)) {
    return out;
  }
  for (const run of runs) {
    const r = asRecord(run);
    if (!r || typeof r.text !== "string" || r.text.trim() === "") {
      continue;
    }
    const id = endpointId(asRecord(r.endpoint));
    if (!id) {
      continue;
    }
    if (id.startsWith("UC")) {
      if (!out.artists.some((e) => e.name === r.text)) {
        out.artists.push({ id, name: r.text as string });
      }
    } else if (id.startsWith("MPRE") && !out.album) {
      out.album = { id, title: r.text as string };
    }
  }
  return out;
}

/**
 * Maps one YouTube Music node to a stable DTO; null = unsupported node.
 * Handles MusicResponsiveListItem (search rows, chart artist rows) and
 * MusicTwoRowItem (album/carousel cards, chart playlist cards).
 */
export function mapMusicItem(node: unknown): MusicItemDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const lower = type.toLowerCase();
  const isList = lower === "musicresponsivelistitem";
  const isCard = lower === "musictworowitem";
  if (!isList && !isCard) {
    return null;
  }

  const endpoint = asRecord(n.endpoint);
  // Explicit item_type wins when it names a known kind (artist rows carry
  // item_type "artist"; song rows often omit it).
  const rawItemType = String(n.item_type ?? "").toLowerCase();
  const typedKind: MusicKind | null =
    rawItemType === "song" ||
    rawItemType === "album" ||
    rawItemType === "artist" ||
    rawItemType === "video" ||
    rawItemType === "playlist"
      ? rawItemType
      : null;

  if (isCard) {
    const id =
      (typeof n.id === "string" && n.id !== "" ? n.id : undefined) ??
      endpointId(endpoint);
    if (!id) {
      return null;
    }
    // Never invent a kind: a card with no recognizable endpoint/item_type is
    // dropped rather than served as a fabricated playlist.
    const kind = typedKind ?? kindFromEndpoint(endpoint);
    if (!kind) {
      return null;
    }
    const dto: MusicItemDTO = {
      id,
      kind,
      title: textOf(n.title) ?? "Untitled",
    };
    const subtitle = textOf(n.subtitle);
    if (subtitle) {
      dto.subtitle = subtitle;
    }
    const thumbs = normalizeThumbs(n.thumbnail ?? n.thumbnails);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }

  // MusicResponsiveListItem branch.
  const flex = spreadChildren(n.flex_columns);
  const firstCol = asRecord(flex[0]);
  const firstTitle = asRecord(firstCol?.title);
  const watchEndpoint = asRecord(firstTitle?.endpoint) ?? endpoint;
  const id =
    (typeof n.id === "string" && n.id !== "" ? n.id : undefined) ??
    endpointId(watchEndpoint) ??
    endpointId(endpoint);
  if (!id) {
    return null;
  }
  // Song vs video: an ATV watch config marks an audio track (song); a plain
  // watch endpoint without one reads as video. Browse endpoints classify by
  // browseId prefix.
  const watchPayload = asRecord(watchEndpoint?.payload);
  const musicVideoType = String(
    asRecord(
      asRecord(watchPayload?.watchEndpointMusicSupportedConfigs)
        ?.watchEndpointMusicConfig,
    )?.musicVideoType ?? "",
  ).toUpperCase();
  let kind: MusicKind | null = typedKind;
  if (!kind) {
    if (watchPayload && typeof watchPayload.videoId === "string") {
      kind = musicVideoType.includes("ATV") ? "song" : "video";
    } else {
      kind = kindFromEndpoint(watchEndpoint) ?? kindFromEndpoint(endpoint);
    }
  }
  if (!kind) {
    return null;
  }
  const dto: MusicItemDTO = {
    id,
    kind,
    title:
      textOf(firstTitle) ?? textOf(n.title) ?? textOf(n.name) ?? "Untitled",
  };
  // Artists/album ride in the secondary columns' runs (artist • album •
  // duration) and/or the structured artists/album fields.
  const artists: Array<{ id?: string; name: string }> = [];
  const structured = n.artists ?? n.authors;
  if (Array.isArray(structured)) {
    for (const a of structured) {
      const r = asRecord(a);
      const name =
        (typeof r?.name === "string" && r.name) ||
        textOf(r?.title) ||
        textOf(a);
      if (name) {
        const aid =
          (typeof r?.id === "string" && r.id.startsWith("UC") && r.id) ||
          undefined;
        artists.push(aid ? { id: aid, name } : { name });
      }
    }
  }
  for (const col of flex.slice(1)) {
    const colRec = asRecord(col);
    const runs = asRecord(colRec?.title)?.runs;
    const credits = mapRunCredits(runs);
    for (const a of credits.artists) {
      if (!artists.some((e) => e.name === a.name)) {
        artists.push(a);
      }
    }
    if (!dto.album && credits.album) {
      dto.album = credits.album;
    }
  }
  if (artists.length > 0) {
    dto.artists = artists.slice(0, 10);
  }
  const albumRec = asRecord(n.album);
  if (albumRec) {
    const albumId =
      (typeof albumRec.id === "string" && albumRec.id) ||
      endpointId(asRecord(albumRec.endpoint)) ||
      undefined;
    const albumTitle = textOf(albumRec.title) ?? textOf(albumRec);
    if (albumId || albumTitle) {
      dto.album = {};
      if (albumId) {
        dto.album.id = albumId;
      }
      if (albumTitle) {
        dto.album.title = albumTitle;
      }
    }
  }
  const duration =
    parseDurationText(n.duration) ??
    (typeof asRecord(n.duration)?.seconds === "number"
      ? (asRecord(n.duration)?.seconds as number)
      : undefined);
  if (duration === undefined) {
    for (const col of flex.slice(1)) {
      const runs = asRecord(asRecord(col)?.title)?.runs;
      if (Array.isArray(runs)) {
        for (const run of runs) {
          const d = parseDurationText(asRecord(run)?.text);
          if (d !== undefined) {
            dto.durationSeconds = Math.round(d);
            break;
          }
        }
      }
      if (dto.durationSeconds !== undefined) {
        break;
      }
    }
  } else {
    dto.durationSeconds = Math.round(duration);
  }
  const subtitle =
    textOf(n.subtitle) ??
    (kind === "artist" ? textOf(asRecord(flex[1])?.title) : undefined);
  if (subtitle) {
    dto.subtitle = subtitle;
  }
  const thumbs = normalizeThumbs(n.thumbnail ?? n.thumbnails);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Search adapter: music Search -> generic continuation page.
// ---------------------------------------------------------------------------

export interface MusicSearchPage {
  results: unknown[];
  has_continuation: boolean;
  getContinuation: () => Promise<MusicSearchPage>;
}

/**
 * Adapts a `music.search` Search ({ header, contents: shelves }) to the
 * generic continuation-page shape. Items are the flattened shelf rows; the
 * continuation re-adapts the next immutable Search page.
 */
export function adaptMusicSearch(result: {
  contents?: unknown;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): MusicSearchPage {
  const shelves = spreadChildren(result.contents);
  const results: unknown[] = [];
  for (const shelf of shelves) {
    const s = asRecord(shelf);
    if (!s) {
      results.push(shelf);
      continue;
    }
    const rows = spreadChildren(s.contents);
    if (rows.length > 0) {
      results.push(...rows);
    } else {
      results.push(shelf);
    }
  }
  return {
    results,
    has_continuation: result.has_continuation,
    getContinuation: async () =>
      adaptMusicSearch(
        (await result.getContinuation()) as Parameters<
          typeof adaptMusicSearch
        >[0],
      ),
  };
}

/**
 * Maps our public `type` filter to the youtubei music search filter.
 * "all" has no upstream filter — omit it explicitly so default search never
 * relies on an undefined enum lookup.
 */
export function toUpstreamMusicFilter(type: MusicSearchType): {
  type?: "song" | "album" | "artist" | "video" | "playlist";
} {
  return type === "all" ? {} : { type };
}

// ---------------------------------------------------------------------------
// Artist profile DTO.
// ---------------------------------------------------------------------------

export interface ArtistTopSongDTO {
  id: string;
  title: string;
  artists?: Array<{ id?: string; name: string }>;
  album?: { id?: string; title?: string };
  durationSeconds?: number;
  thumbnails?: Thumbnail[];
}

export interface ArtistAlbumDTO {
  id: string;
  title: string;
  year?: string;
  subtitle?: string;
  thumbnails?: Thumbnail[];
}

export interface ArtistProfileDTO {
  id: string;
  name: string;
  description?: string;
  thumbnails?: Thumbnail[];
  subscriberCount?: number;
  topSongs: ArtistTopSongDTO[];
  albums: ArtistAlbumDTO[];
}

/**
 * Maps a `music.getArtist` payload ({ header, sections }) to a stable
 * profile DTO. The "Top songs" MusicShelf yields topSongs, "Albums" /
 * "Singles & EPs" carousels merge into albums. Returns null when the payload
 * carries no usable artist identity at all (callers treat that as 404).
 */
export function mapArtistProfile(
  artist: unknown,
  fallbackId?: string,
): ArtistProfileDTO | null {
  const root = asRecord(artist);
  if (!root) {
    return null;
  }
  const header = asRecord(root.header);
  // A usable profile needs a header (or at minimum a root title) — a bare
  // {} with only a fallback id is a hollow payload, i.e. 404, not a profile
  // named after its own id.
  if (!header && !textOf(root.title)) {
    return null;
  }
  const name =
    textOf(header?.title) ?? textOf(root.title) ?? fallbackId ?? undefined;
  if (!name) {
    return null;
  }
  const dto: ArtistProfileDTO = {
    id: fallbackId ?? "",
    name,
    topSongs: [],
    albums: [],
  };
  // Header identity: prefer an explicit channel/artist id, else the fallback.
  const headerId =
    (typeof header?.channel_id === "string" && header.channel_id) ||
    (typeof header?.browse_id === "string" && header.browse_id) ||
    endpointId(asRecord(header?.endpoint)) ||
    fallbackId ||
    undefined;
  if (!headerId) {
    return null;
  }
  dto.id = headerId;

  const description = textOf(header?.description) ?? textOf(header?.subtitle);
  if (description) {
    dto.description = description.slice(0, 5000);
  }
  const thumbs = normalizeThumbs(header?.thumbnail ?? header?.thumbnails);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  // Monthly-audience / subscriber text lives in header description runs or
  // subtitle text ("375M monthly audience", "15.7M subscribers").
  const audience =
    parseCountText(header?.description) ??
    parseCountText(header?.subtitle) ??
    parseCountText(header?.subscriber_count_text);
  if (audience !== undefined) {
    dto.subscriberCount = Math.round(audience);
  }

  for (const section of spreadChildren(root.sections)) {
    const sec = asRecord(section);
    if (!sec) {
      continue;
    }
    const title =
      textOf(sec.title) ?? textOf(asRecord(sec.header)?.title) ?? "";
    const rows = spreadChildren(sec.contents);
    if (/top songs/i.test(title)) {
      for (const row of rows) {
        const mapped = mapMusicItem(row);
        if (!mapped || (mapped.kind !== "song" && mapped.kind !== "video")) {
          continue;
        }
        const song: ArtistTopSongDTO = { id: mapped.id, title: mapped.title };
        if (mapped.artists) {
          song.artists = mapped.artists;
        }
        if (mapped.album) {
          song.album = mapped.album;
        }
        if (mapped.durationSeconds !== undefined) {
          song.durationSeconds = mapped.durationSeconds;
        }
        if (mapped.thumbnails) {
          song.thumbnails = mapped.thumbnails;
        }
        dto.topSongs.push(song);
      }
    } else if (/albums?|singles?|\beps?\b/i.test(title)) {
      for (const row of rows) {
        const mapped = mapMusicItem(row);
        if (
          !mapped ||
          (mapped.kind !== "album" && mapped.kind !== "playlist")
        ) {
          continue;
        }
        const album: ArtistAlbumDTO = { id: mapped.id, title: mapped.title };
        const year = mapped.subtitle?.match(/(19|20)\d{2}/)?.[0];
        if (year) {
          album.year = year;
        }
        if (mapped.subtitle) {
          album.subtitle = mapped.subtitle;
        }
        if (mapped.thumbnails) {
          album.thumbnails = mapped.thumbnails;
        }
        dto.albums.push(album);
      }
    }
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Charts: section extraction + mapping.
// ---------------------------------------------------------------------------

export interface ChartSectionDTO {
  title: string;
  items: MusicItemDTO[];
}

/**
 * Navigates a parsed charts browse response to its shelf array:
 * SingleColumnBrowseResults -> selected (else first) tab -> content
 * (SectionList) -> contents. Any shape mismatch yields [] so callers serve
 * data:[] + next:null instead of fabricating sections.
 */
export function extractChartShelves(browse: unknown): unknown[] {
  const root = asRecord(browse);
  if (!root) {
    return [];
  }
  // actions.execute(parse:true) wraps the node in a SuperParsedResult
  // exposing .item(); tolerate both wrapped and bare payloads.
  const maybeItem = (root as Record<string, unknown>).item;
  const node =
    typeof maybeItem === "function"
      ? ((maybeItem as () => unknown).call(root) as unknown)
      : browse;
  const nodeRec = asRecord(node) ?? root;
  const tabs = spreadChildren(nodeRec.tabs);
  if (tabs.length === 0) {
    return [];
  }
  const selected = tabs.find((t) => asRecord(t)?.selected === true) ?? tabs[0];
  const content = asRecord(asRecord(selected)?.content);
  if (!content) {
    return [];
  }
  return spreadChildren(content.contents);
}

/**
 * Maps chart shelves to titled sections. Shelves with neither a title nor
 * mappable items (e.g. the lazily-filled top-songs MusicShelf on first
 * paint) are skipped — never served hollow, never fabricated.
 */
export function mapChartSections(
  shelves: unknown[],
  limit: number = DEFAULT_LIMIT,
): ChartSectionDTO[] {
  const sections: ChartSectionDTO[] = [];
  for (const shelf of shelves) {
    const s = asRecord(shelf);
    if (!s) {
      continue;
    }
    const title =
      textOf(s.title) ?? textOf(asRecord(s.header)?.title) ?? undefined;
    const items = spreadChildren(s.contents)
      .slice(0, limit)
      .map(mapMusicItem)
      .filter((d): d is MusicItemDTO => d !== null);
    if (!title && items.length === 0) {
      continue;
    }
    sections.push({ title: title ?? "Untitled section", items });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Error classifiers (never leak stack traces).
// ---------------------------------------------------------------------------

export interface ClassifiedMusicError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

/** Timeouts/aborts -> 504 upstream_timeout; everything else -> 502. */
export function classifyMusicSearchError(err: unknown): ClassifiedMusicError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Music search timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Music search failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

/**
 * Timeouts -> 504; unknown/private/deleted artists and unresolvable ids ->
 * 404 artist_not_found; everything else -> 502 upstream_degraded.
 */
export function classifyArtistError(err: unknown): ClassifiedMusicError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Artist lookup timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  if (
    /artist.{0,60}(not.?found|not found|unavailable|not available|invalid|does.?not.?exist)|not.?found.{0,40}artist|unknown artist|\b404\b.{0,40}artist|artist.{0,40}\b404\b|no artist|empty artist|NOT_FOUND/i.test(
      raw,
    )
  ) {
    return {
      code: "artist_not_found",
      message: "Artist not found or unavailable.",
      hint: "Check the artist id, or find ids via /api/v1/music/search?type=artist.",
      status: 404,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Artist lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

/** Charts: timeouts -> 504; empty upstream -> served as data:[] by callers. */
export function classifyChartsError(err: unknown): ClassifiedMusicError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Charts lookup timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Charts lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}
