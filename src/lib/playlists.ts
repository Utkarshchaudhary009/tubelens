// Phase 5 (Playlists) pure helpers + shared handlers.
// Mirrors src/lib/channels.ts: validation, DTO mappers, error classifier,
// and feed/profile handlers stay pure and unit-testable without network
// (tolerant `Record<string, unknown>` access — node shapes vary across
// youtubei.js clients). Route files stay thin wrappers with their own deps
// seam (see src/app/api/v1/playlists/_lib.ts).

import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { classifyChannelError, parseChannelId } from "@/lib/channels";
import {
  type ContinuationSearch,
  dropContinuation,
  forkContinuation,
  hasMoreResults,
  resolveNext,
  storeContinuation,
  takeContinuation,
} from "@/lib/continuations";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { type Thumbnail, textOf } from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

// ---------------------------------------------------------------------------
// Path validation: YouTube playlist ids (PL*, UU*, RD*, OL*, FL*, LM* …).
// ---------------------------------------------------------------------------

const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

export interface ParsedPlaylistId {
  /** The raw path value (trimmed). */
  value: string;
}

export interface PlaylistIdError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export type PlaylistIdResult =
  | { ok: true; value: ParsedPlaylistId }
  | { ok: false; error: PlaylistIdError };

/**
 * Pure validation for /api/v1/playlists/:id path params. Accepts the broad
 * playlist-id charset (mix, RD, UU and OL ids qualify too) — existence is
 * checked upstream, where an unknown id maps to 404 playlist_not_found.
 */
export function parsePlaylistId(raw: string): PlaylistIdResult {
  const value = (raw ?? "").trim();
  if (PLAYLIST_ID.test(value)) {
    return { ok: true, value: { value } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_playlist_id",
      message: "Invalid playlist id.",
      hint: "Use a playlist id, e.g. /api/v1/playlists/PLplXQ2cg9B_qrCVd1J_iId5SvP8Kf_BfS.",
      status: 400,
    },
  };
}

// ---------------------------------------------------------------------------
// Small tolerant readers (mirror the defensive style of lib/channels).
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

function normalizeThumbs(v: unknown): Thumbnail[] | undefined {
  const list = Array.isArray(v)
    ? v
    : (v as { thumbnails?: unknown } | null)?.thumbnails;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: Thumbnail[] = [];
  for (const t of list) {
    if (typeof t !== "object" || t === null) {
      continue;
    }
    const o = t as Record<string, unknown>;
    if (typeof o.url !== "string") {
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

function firstThumbs(...candidates: Array<unknown>): Thumbnail[] | undefined {
  for (const c of candidates) {
    const thumbs = normalizeThumbs(c);
    if (thumbs) {
      return thumbs;
    }
  }
  return undefined;
}

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? "");
}

/** Leading integer of a count text ("127", "127 videos", "1,234") — else undefined. */
function parseCountText(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.round(v);
  }
  const text = textOf(v);
  if (!text) {
    return undefined;
  }
  const digits = text.replace(/,/g, "").match(/[\d.]+/);
  if (!digits?.[0]) {
    return undefined;
  }
  const n = Number(digits[0]);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function videoIdOf(n: Record<string, unknown>): string | undefined {
  for (const key of ["video_id", "id", "content_id", "entity_id"]) {
    const v = n[key];
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Playlist profile DTO.
// ---------------------------------------------------------------------------

export interface PlaylistProfileDTO {
  id: string;
  title: string;
  description?: string;
  channelId?: string;
  channelTitle?: string;
  itemCount?: number;
  thumbnails?: Thumbnail[];
  /** Upstream privacy label ("PUBLIC", "UNLISTED", …) when served. */
  privacy?: string;
}

/**
 * Maps a getPlaylist Playlist object to a stable profile DTO. Reads the
 * `info` block (title, description, author, total_items, thumbnails,
 * privacy) — whichever fields the client served. Returns null when the
 * payload carries no usable playlist identity at all.
 */
export function mapPlaylistProfile(
  playlist: unknown,
  fallbackId?: string,
): PlaylistProfileDTO | null {
  const root = asRecord(playlist);
  if (!root) {
    return null;
  }
  const info = asRecord(root.info);
  if (!info) {
    return null;
  }
  const id =
    (typeof root.id === "string" && root.id) ||
    (typeof info.id === "string" && info.id) ||
    fallbackId ||
    undefined;
  if (!id) {
    return null;
  }
  const title = textOf(info.title);
  if (!title) {
    return null;
  }
  const dto: PlaylistProfileDTO = { id, title };
  const description = textOf(info.description);
  if (description) {
    dto.description = description.slice(0, 5000);
  }
  const author = asRecord(info.author);
  const channelId =
    (typeof author?.id === "string" && author.id) ||
    (typeof info.channel_id === "string" && info.channel_id) ||
    undefined;
  if (channelId) {
    dto.channelId = channelId;
  }
  const channelTitle =
    (typeof author?.name === "string" && author.name) ||
    textOf(author?.name) ||
    textOf(info.author_name);
  if (channelTitle) {
    dto.channelTitle = channelTitle;
  }
  const itemCount = parseCountText(info.total_items ?? info.item_count);
  if (itemCount !== undefined) {
    dto.itemCount = itemCount;
  }
  const thumbs = firstThumbs(info.thumbnails, info.thumbnail, root.thumbnails);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  if (typeof info.privacy === "string" && info.privacy !== "") {
    dto.privacy = info.privacy;
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Playlist item DTO with typed deleted/private placeholders.
// ---------------------------------------------------------------------------

export type PlaylistItemKind = "video" | "deleted" | "private";

export interface PlaylistItemDTO {
  /** Watch id. Absent on placeholders whose node serves no id. */
  id?: string;
  title: string;
  kind: PlaylistItemKind;
  /** 1-based position inside the playlist, when served. */
  position?: number;
  channelTitle?: string;
  durationSeconds?: number;
  thumbnails?: Thumbnail[];
}

function positionOf(n: Record<string, unknown>): number | undefined {
  const raw = n.index ?? n.position;
  const text = textOf(raw);
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (!text) {
    return undefined;
  }
  const m = text.match(/\d+/);
  if (!m?.[0]) {
    return undefined;
  }
  const num = Number(m[0]);
  return Number.isInteger(num) ? num : undefined;
}

function durationOf(n: Record<string, unknown>): number | undefined {
  const d = asRecord(n.duration);
  if (typeof d?.seconds === "number" && Number.isFinite(d.seconds)) {
    return Math.round(d.seconds);
  }
  const text =
    (typeof d?.text === "string" && d.text) ||
    textOf(n.length_text) ||
    textOf(n.duration);
  if (!text) {
    return undefined;
  }
  const parts = text
    .trim()
    .split(":")
    .map((p) => Number(p));
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((p) => !Number.isInteger(p) || p < 0)
  ) {
    return undefined;
  }
  const [a, b, c] = parts as number[];
  if (c === undefined) {
    if (b >= 60) {
      return undefined;
    }
    return a * 60 + b;
  }
  if (b >= 60 || c >= 60) {
    return undefined;
  }
  return a * 3600 + b * 60 + c;
}

/**
 * Deleted/private placeholder: an unplayable PlaylistVideo degrades to a
 * typed DTO, never null and never a throw. "Deleted video" -> deleted,
 * everything else unplayable (incl. "Private video") -> private.
 */
function placeholderItem(n: Record<string, unknown>): PlaylistItemDTO {
  const title = textOf(n.title) ?? "Unavailable video";
  const kind: PlaylistItemKind = /deleted/i.test(title) ? "deleted" : "private";
  const dto: PlaylistItemDTO = { title, kind };
  const id = videoIdOf(n);
  if (id) {
    dto.id = id;
  }
  const position = positionOf(n);
  if (position !== undefined) {
    dto.position = position;
  }
  const author = asRecord(n.author);
  const channelTitle =
    (typeof author?.name === "string" && author.name) || textOf(author?.name);
  if (channelTitle) {
    dto.channelTitle = channelTitle;
  }
  return dto;
}

/**
 * PlaylistVideo (playable -> video DTO; is_playable=false -> typed
 * placeholder), plus LockupView/ReelItem/ShortsLockupView item shapes that
 * some clients serve inside playlists. Playlist/channel-shaped nodes map to
 * null and are dropped by callers — only deleted/private videos degrade to
 * placeholders, never to drops or 500s.
 */
export function mapPlaylistItem(node: unknown): PlaylistItemDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const lower = type.toLowerCase();
  if (lower === "playlistvideo" || lower === "playlistpanelvideo") {
    // Deleted/private videos surface as PlaylistVideo with
    // is_playable=false and a stock title — placeholder, never dropped.
    if (n.is_playable === false) {
      return placeholderItem(n);
    }
    const id = videoIdOf(n);
    if (!id) {
      return null;
    }
    const dto: PlaylistItemDTO = {
      id,
      title: textOf(n.title) ?? "Untitled",
      kind: "video",
    };
    const position = positionOf(n);
    if (position !== undefined) {
      dto.position = position;
    }
    const author = asRecord(n.author);
    const channelTitle =
      (typeof author?.name === "string" && author.name) || textOf(author?.name);
    if (channelTitle) {
      dto.channelTitle = channelTitle;
    }
    const duration = durationOf(n);
    if (duration !== undefined) {
      dto.durationSeconds = duration;
    }
    const thumbs = firstThumbs(n.thumbnails, n.thumbnail);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }
  if (lower === "lockupview") {
    const ct = String(n.content_type ?? "").toUpperCase();
    if (ct !== "" && ct !== "VIDEO" && ct !== "SHORT") {
      return null;
    }
    const id =
      typeof n.content_id === "string" && n.content_id
        ? n.content_id
        : undefined;
    if (!id) {
      return null;
    }
    const metadata = asRecord(n.metadata);
    const dto: PlaylistItemDTO = {
      id,
      title: textOf(metadata?.title) ?? textOf(n.title) ?? "Untitled",
      kind: "video",
    };
    const thumbs = firstThumbs(
      asRecord(n.content_image)?.thumbnails,
      n.thumbnails,
      n.thumbnail,
    );
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }
  if (lower === "reelitem" || lower === "shortslockupview") {
    const overlay = asRecord(n.overlay_metadata);
    const tapPayload = asRecord(asRecord(n.on_tap_endpoint)?.payload);
    const tapId =
      (typeof tapPayload?.videoId === "string" && tapPayload.videoId) ||
      (typeof tapPayload?.video_id === "string" && tapPayload.video_id) ||
      undefined;
    const id = tapId ?? videoIdOf(n);
    if (!id) {
      return null;
    }
    const dto: PlaylistItemDTO = {
      id,
      title:
        textOf(overlay?.primary_text) ??
        ((typeof n.accessibility_text === "string" && n.accessibility_text) ||
          textOf(n.title)) ??
        "Untitled",
      kind: "video",
    };
    const thumbs = firstThumbs(n.thumbnail, n.thumbnails);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel playlist DTO (playlists created by a channel).
// ---------------------------------------------------------------------------

export interface ChannelPlaylistDTO {
  id: string;
  title: string;
  itemCount?: number;
  thumbnails?: Thumbnail[];
}

/**
 * GridPlaylist plus LockupView PLAYLIST (the shapes Channel.getPlaylists
 * serves). Video/channel nodes map to null and are dropped by callers.
 */
export function mapChannelPlaylist(node: unknown): ChannelPlaylistDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const lower = type.toLowerCase();
  if (lower === "lockupview") {
    if (String(n.content_type ?? "").toUpperCase() !== "PLAYLIST") {
      return null;
    }
    const id =
      typeof n.content_id === "string" && n.content_id ? n.content_id : null;
    if (!id) {
      return null;
    }
    const metadata = asRecord(n.metadata);
    const title = textOf(metadata?.title) ?? textOf(n.title);
    if (!title) {
      return null;
    }
    const dto: ChannelPlaylistDTO = { id, title };
    const thumbs = firstThumbs(
      asRecord(n.content_image)?.thumbnails,
      n.thumbnails,
      n.thumbnail,
    );
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }
  if (/playlist/i.test(type) && !/video/i.test(type)) {
    const id =
      (typeof n.playlist_id === "string" && n.playlist_id) ||
      videoIdOf(n) ||
      undefined;
    if (!id) {
      return null;
    }
    const title = textOf(n.title);
    if (!title) {
      return null;
    }
    const dto: ChannelPlaylistDTO = { id, title };
    const itemCount = parseCountText(n.video_count ?? n.video_count_text);
    if (itemCount !== undefined) {
      dto.itemCount = itemCount;
    }
    const thumbs = firstThumbs(n.thumbnails, n.thumbnail);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    return dto;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error classifier.
// ---------------------------------------------------------------------------

export interface ClassifiedPlaylistError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

/**
 * Timeouts/aborts -> 504 upstream_timeout; unknown/private/deleted/
 * unviewable playlists -> 404 playlist_not_found; everything else -> 502
 * upstream_degraded. Never leaks stack traces.
 */
export function classifyPlaylistError(err: unknown): ClassifiedPlaylistError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Playlist lookup timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  if (
    /playlist_not_found|playlist.{0,80}(not.?found|unavailable|not available|invalid|does.?not.?exist|terminated|private|deleted|removed|unviewable)|not.?found.{0,80}playlist|invalid playlist|unknown playlist|\b404\b.{0,40}playlist|playlist.{0,40}\b404\b/i.test(
      raw,
    )
  ) {
    return {
      code: "playlist_not_found",
      message: "Playlist not found or unavailable.",
      hint: "Check the playlist id, or resolve the URL via /api/v1/resolve first.",
      status: 404,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Playlist lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

/**
 * Stale-retry gate for serve-stale-on-error: only transient upstream
 * failures (timeouts/aborts, 429 rate limits, 5xx) may serve a stale cached
 * copy. Definitive failures — not-found, unviewable, and other permanent
 * 4xx (400/403 etc.) — must always surface as errors, never a stale 200.
 */
export function isTransientUpstreamError(err: unknown): boolean {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return true;
  }
  if (/\b429\b|too many requests|rate.?limited|rate_limit/i.test(raw)) {
    return true;
  }
  if (
    /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(
      raw,
    )
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Feed adapter: Playlist / PlaylistContinuation -> ContinuationSearch.
// ---------------------------------------------------------------------------

/**
 * Adapts a playlist page to the generic continuation-page shape. Real
 * Playlist objects expose the Feed `items` getter (memo-flattened
 * PlaylistVideo nodes), `has_continuation`, and an immutable
 * `getContinuation()` — the same contract Search/Comments/Channel adapt. A
 * playlist with no items yields a terminal empty page, never a 404.
 */
export function adaptPlaylistFeed(feed: {
  items?: { [Symbol.iterator](): Iterator<unknown> } | null;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  // A truthy-but-non-iterable `items` (partial mocks, client drift) is an
  // empty page — never a spread TypeError turned 500.
  const results =
    feed.items !== null &&
    feed.items !== undefined &&
    typeof feed.items[Symbol.iterator] === "function"
      ? [...feed.items]
      : [];
  return {
    results,
    has_continuation: feed.has_continuation,
    getContinuation: async () =>
      adaptPlaylistFeed(
        (await feed.getContinuation()) as Parameters<
          typeof adaptPlaylistFeed
        >[0],
      ),
  };
}

/** Terminal empty playlist page (empty playlist, guarded tab). */
export function emptyPlaylistFeed(): ContinuationSearch {
  return {
    results: [],
    has_continuation: false,
    getContinuation: async () => emptyPlaylistFeed(),
  };
}

/** Present-and-iterable check shared by the channel-playlists adapter. */
function asIterableList(v: unknown): unknown[] | undefined {
  if (
    v !== null &&
    v !== undefined &&
    typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  ) {
    return [...(v as Iterable<unknown>)];
  }
  return undefined;
}

/**
 * Last-resort node collector for channel-playlists tab shapes whose memo
 * getters are missing (client drift, partial payloads): walks
 * `current_tab.content.contents…items` (e.g. contents[0].contents[0].items)
 * up to 5 levels deep and gathers every `items` array found. Non-playlist
 * nodes in the harvest are dropped by mapChannelPlaylist downstream.
 */
function currentTabPlaylistNodes(tab: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || typeof node !== "object" || node === null) {
      return;
    }
    const r = node as Record<string, unknown>;
    if (Array.isArray(r.items)) {
      out.push(...r.items);
      return;
    }
    for (const key of ["content", "contents"]) {
      const child = r[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          visit(c, depth + 1);
        }
      } else if (typeof child === "object" && child !== null) {
        visit(child, depth + 1);
      }
    }
  };
  visit(tab, 0);
  return out;
}

/**
 * Adapts a channel-playlists tab page to the generic continuation-page
 * shape. The Channel returned by `getPlaylists()` (and its
 * ChannelListContinuation pages) carries playlist nodes in the Feed
 * `playlists` memo — NOT the `videos` memo that adaptChannelTab reads
 * (verified live: ~30 LockupView PLAYLIST nodes in `playlists`, `videos`
 * empty). Selects the first NON-EMPTY source among the `playlists` memo,
 * the `items` getter, and the raw current_tab walk — a present-but-empty
 * memo falls through to the drift fallbacks instead of masking them; a tab
 * with no nodes anywhere yields a terminal empty page, never a 404.
 * Continuations re-adapt through this same function, so pages 2+ read the
 * same source.
 */
export function adaptChannelPlaylistsPage(feed: {
  playlists?: { [Symbol.iterator](): Iterator<unknown> } | null;
  items?: { [Symbol.iterator](): Iterator<unknown> } | null;
  current_tab?: unknown;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  const candidates = [
    asIterableList(feed.playlists),
    asIterableList(feed.items),
    currentTabPlaylistNodes(feed.current_tab),
  ];
  const results = candidates.find((list) => (list?.length ?? 0) > 0) ?? [];
  return {
    results,
    has_continuation: feed.has_continuation,
    getContinuation: async () =>
      adaptChannelPlaylistsPage(
        (await feed.getContinuation()) as Parameters<
          typeof adaptChannelPlaylistsPage
        >[0],
      ),
  };
}

// ---------------------------------------------------------------------------
// Shared playlist deps seams (defaults live in route _lib via lazy import).
// ---------------------------------------------------------------------------

export interface PlaylistProfileDeps {
  /** Playlist id -> raw getPlaylist payload (info + items). */
  fetchPlaylist: (playlistId: string) => Promise<unknown>;
}

export interface PlaylistFeedDeps {
  /** Playlist id -> adapted first items page (or terminal empty page). */
  fetchFirstPage: (playlistId: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

export interface ChannelPlaylistsDeps {
  /** UC id or @handle -> canonical UC channel id (handles via resolveURL). */
  resolveChannelId: (input: string) => Promise<string>;
  /** Canonical UC id -> adapted first playlists page (or terminal empty). */
  fetchFirstPage: (channelId: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

function invalidLimitResponse(requestId: string): NextResponse {
  return errorResponse(requestId, {
    code: "invalid_limit",
    message: "Invalid limit.",
    hint: "Use an integer between 1 and 50; defaults to 20.",
    status: 400,
  });
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// playlist reads are locale-independent and the cache key is just the
// playlist id + limit.
export async function handlePlaylistProfile(
  req: NextRequest,
  rawId: string,
  deps: PlaylistProfileDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const parsed = parsePlaylistId(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return invalidLimitResponse(requestId);
  }

  try {
    const playlistId = parsed.value.value;
    const cacheKey = `playlist:profile:v1:${playlistId}:${limit}`;
    // L0 caches the profile plus page-1 ITEMS plus the fork-source cursor
    // string only. The stored source is NEVER served directly — every caller
    // (miss or hit) gets a FRESH cursor via forkContinuation (own snapshot
    // entry), so the source stays pristine and concurrent users never share
    // mutable entry state. An evicted/expired fork source degrades to
    // next: null. The forked cursor is scoped `playlist:{id}` so it also
    // resolves under /playlists/:id/items (pages 2+).
    const result = await cached<{
      profile: PlaylistProfileDTO;
      items: PlaylistItemDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
      async () => {
        const raw = await deps.fetchPlaylist(playlistId);
        const profile = mapPlaylistProfile(raw, playlistId);
        if (!profile) {
          throw new Error(`playlist_not_found: ${playlistId}`);
        }
        const page = adaptPlaylistFeed(
          raw as Parameters<typeof adaptPlaylistFeed>[0],
        );
        const items = page.results
          .slice(0, limit)
          .map(mapPlaylistItem)
          .filter((d): d is PlaylistItemDTO => d !== null);
        const forkFrom = storeContinuation(
          page,
          limit,
          `playlist:${playlistId}`,
        );
        return { profile, items, forkFrom };
      },
      24 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Only transient failures (timeout/429/5xx) may serve stale —
      // definitive errors (not-found, unviewable, other permanent 4xx)
      // propagate below.
      (err) => isTransientUpstreamError(err),
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(
      result.value.forkFrom,
      `playlist:${playlistId}`,
    );
    // Cursors are process-local (see src/lib/continuations.ts): a response
    // carrying one must never sit in the shared CDN, or a replay on another
    // instance resolves it to [] + next: null. Only exhausted first pages
    // (next == null) keep the public TTL.
    return successResponse(
      { playlist: result.value.profile, items: result.value.items },
      {
        requestId,
        next,
        region,
        lang,
        cached: result.hit,
        warnings: result.stale
          ? [
              {
                code: "stale_served",
                message: "Upstream failed; serving a stale cached copy.",
              },
            ]
          : [],
        cacheControl:
          next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.playlist,
      },
    );
  } catch (err) {
    return errorResponse(requestId, classifyPlaylistError(err));
  }
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// Playlist item order is the upstream order; pages walk it stably via the
// forked cursor scope `playlist:{id}` (shared with the profile route's
// first-page cursor, so page 1 from /playlists/:id continues here).
export async function handlePlaylistFeed(
  req: NextRequest,
  rawId: string,
  deps: PlaylistFeedDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const parsed = parsePlaylistId(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return invalidLimitResponse(requestId);
  }

  const cursor = params.get("cursor");

  try {
    const playlistId = parsed.value.value;
    // Cursor scope binds this playlist: a cursor minted for another playlist
    // or endpoint is terminal ([] + next: null) and never yields foreign
    // items. Scopes live server-side in the continuation entry; the opaque
    // cursor itself reveals nothing.
    const scope = `playlist:${playlistId}`;

    // Cursor requests skip re-fetching page 1 — only limit/region/lang
    // apply. Unknown/expired cursors yield [] + next: null, never an error.
    if (cursor) {
      return servePlaylistContinuation(
        requestId,
        region,
        lang,
        scope,
        cursor,
        limit,
        mapPlaylistItem,
        deps.continueFeed,
      );
    }

    const cacheKey = `playlist:items:v1:${playlistId}:${limit}`;
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: PlaylistItemDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const page = await deps.fetchFirstPage(playlistId);
        const items = page.results
          .slice(0, limit)
          .map(mapPlaylistItem)
          .filter((d): d is PlaylistItemDTO => d !== null);
        const forkFrom = storeContinuation(page, limit, scope);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Only transient failures (timeout/429/5xx) may serve stale —
      // definitive errors (not-found, unviewable, other permanent 4xx)
      // propagate below.
      (err) => isTransientUpstreamError(err),
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, scope);
    // Cursors are process-local (see src/lib/continuations.ts): a response
    // carrying one must never sit in the shared CDN, or a replay on another
    // instance resolves it to [] + next: null. Only exhausted first pages
    // (next == null, no cursor involved) keep the public TTL. Cursor-paged
    // requests always take the serveContinuation branch above (no-store).
    return successResponse(result.value.items, {
      requestId,
      next,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached page.",
            },
          ]
        : [],
      cacheControl:
        next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.playlistFeed,
    });
  } catch (err) {
    return errorResponse(requestId, classifyPlaylistError(err));
  }
}

async function servePlaylistContinuation(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  mapItem: (node: unknown) => PlaylistItemDTO | null,
  continueFeed?: (page: ContinuationSearch) => Promise<ContinuationSearch>,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // A cursor minted for another playlist or endpoint is rejected the same way
  // (the foreign cursor is left untouched so it still works under its own
  // playlist + endpoint). Every cursor response is private/no-store: cursors
  // are process-local, so a CDN-cached cursor page would break paging on
  // replay/cross-instance.
  if (!entry || !hasMoreResults(entry)) {
    if (entry) {
      dropContinuation(cursor);
    }
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  if (entry.scope !== undefined && entry.scope !== scope) {
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  // Buffered items remain on this page object: serve from this entry's own
  // offset (per-cursor state — forks own their entry) and keep the cursor.
  if (entry.returned < entry.search.results.length) {
    const items = entry.search.results
      .slice(entry.returned, entry.returned + pageSize)
      .map(mapItem)
      .filter((d): d is PlaylistItemDTO => d !== null);
    entry.returned += pageSize;
    const more = hasMoreResults(entry);
    const next = more ? cursor : null;
    if (next === null) {
      dropContinuation(cursor);
    }
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  // Buffer exhausted but upstream has more: fetch the next immutable page and
  // store it under a NEW cursor. This entry is left untouched, so fork-source
  // cursors (and repeat uses of this one) stay stable.
  try {
    if (!continueFeed) {
      throw new Error("continuation unavailable");
    }
    const nextPage = await continueFeed(entry.search);
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapItem)
      .filter((d): d is PlaylistItemDTO => d !== null);
    const next = resolveNext(storeContinuation(nextPage, pageSize, scope));
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch {
    dropContinuation(cursor);
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      warnings: [
        {
          code: "continuation_failed",
          message: "Could not load the next page upstream.",
        },
      ],
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// channel playlists are locale-independent. The address is resolved to its
// canonical UC id BEFORE caching (on both first-page and cursor paths), so
// @handle and UC form share one scope, one cache entry, and interoperable
// cursors.
export async function handleChannelPlaylists(
  req: NextRequest,
  rawId: string,
  deps: ChannelPlaylistsDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const parsed = parseChannelId(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return invalidLimitResponse(requestId);
  }

  const cursor = params.get("cursor");

  // Channel-address failures (bad id/handle, unknown channel) keep the
  // Phase 4 channel error shapes; playlist-feed failures use the playlist
  // classifier. Both are typed errors with hints, never bare 500s.
  try {
    // Resolve first so scope + cache key are always the canonical UC id —
    // @handle and UC form share entries and cursors. UC inputs skip upstream
    // entirely (pure passthrough); handle resolution failure classifies
    // below (unresolvable handle -> 404 channel_not_found).
    const channelId = await deps.resolveChannelId(parsed.value.value);
    // Cursor scope binds endpoint + resolved channel: a cursor minted for
    // another endpoint or channel is terminal ([] + next: null) and never
    // yields foreign items. Scopes live server-side in the continuation
    // entry; the opaque cursor itself reveals nothing.
    const scope = `channel:playlists:${channelId}`;

    // Cursor requests skip re-fetching page 1 — only limit/region/lang
    // apply. Unknown/expired cursors yield [] + next: null, never an error.
    if (cursor) {
      return serveChannelPlaylistsContinuation(
        requestId,
        region,
        lang,
        scope,
        cursor,
        limit,
        deps,
      );
    }

    const cacheKey = `channel:playlists:v1:${channelId}:${limit}`;
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: ChannelPlaylistDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const page = await deps.fetchFirstPage(channelId);
        const items = page.results
          .slice(0, limit)
          .map(mapChannelPlaylist)
          .filter((d): d is ChannelPlaylistDTO => d !== null);
        const forkFrom = storeContinuation(page, limit, scope);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Only transient failures (timeout/429/5xx) may serve stale —
      // definitive errors (channel_not_found, other permanent 4xx)
      // propagate below.
      (err) => isTransientUpstreamError(err),
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, scope);
    // Cursors are process-local (see src/lib/continuations.ts): a response
    // carrying one must never sit in the shared CDN, or a replay on another
    // instance resolves it to [] + next: null. Only exhausted first pages
    // (next == null, no cursor involved) keep the public TTL. Cursor-paged
    // requests always take the serveContinuation branch above (no-store).
    return successResponse(result.value.items, {
      requestId,
      next,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached page.",
            },
          ]
        : [],
      cacheControl:
        next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.playlistFeed,
    });
  } catch (err) {
    return errorResponse(requestId, classifyChannelError(err));
  }
}

async function serveChannelPlaylistsContinuation(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps?: ChannelPlaylistsDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // A cursor minted for another endpoint or channel is rejected the same way
  // (the foreign cursor is left untouched so it still works under its own
  // endpoint + channel). Every cursor response is private/no-store: cursors
  // are process-local, so a CDN-cached cursor page would break paging on
  // replay/cross-instance.
  if (!entry || !hasMoreResults(entry)) {
    if (entry) {
      dropContinuation(cursor);
    }
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  if (entry.scope !== undefined && entry.scope !== scope) {
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  // Buffered items remain on this page object: serve from this entry's own
  // offset (per-cursor state — forks own their entry) and keep the cursor.
  if (entry.returned < entry.search.results.length) {
    const items = entry.search.results
      .slice(entry.returned, entry.returned + pageSize)
      .map(mapChannelPlaylist)
      .filter((d): d is ChannelPlaylistDTO => d !== null);
    entry.returned += pageSize;
    const more = hasMoreResults(entry);
    const next = more ? cursor : null;
    if (next === null) {
      dropContinuation(cursor);
    }
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  // Buffer exhausted but upstream has more: fetch the next immutable page and
  // store it under a NEW cursor. This entry is left untouched, so fork-source
  // cursors (and repeat uses of this one) stay stable.
  try {
    if (!deps) {
      throw new Error("continuation unavailable");
    }
    const nextPage = await deps.continueFeed(entry.search);
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapChannelPlaylist)
      .filter((d): d is ChannelPlaylistDTO => d !== null);
    const next = resolveNext(storeContinuation(nextPage, pageSize, scope));
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch {
    dropContinuation(cursor);
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      warnings: [
        {
          code: "continuation_failed",
          message: "Could not load the next page upstream.",
        },
      ],
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
}
