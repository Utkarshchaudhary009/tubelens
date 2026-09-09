// Phase 4 (Channels) pure helpers + shared feed handler.
// Validation, DTO mappers, error classifier, and tab adapter stay pure and
// unit-testable without network (tolerant `Record<string, unknown>` access —
// node shapes vary across youtubei.js clients). The shared feed handler at
// the bottom wires cache/continuations/envelope exactly like the hashtag and
// comments routes; route files stay thin wrappers with their own deps seam.

import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
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
// Path validation: UC* channel ids and @handles.
// ---------------------------------------------------------------------------

const STRICT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{20,}$/;
const HANDLE = /^@[A-Za-z0-9_.-]{1,64}$/;

export interface ParsedChannelId {
  /** "id" for UC* ids, "handle" for @handles. */
  kind: "id" | "handle";
  /** The raw path value (trimmed). */
  value: string;
}

export interface ChannelIdError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export type ChannelIdResult =
  | { ok: true; value: ParsedChannelId }
  | { ok: false; error: ChannelIdError };

/**
 * Pure validation for /api/v1/channels/:id path params. Accepts strict UC*
 * ids and @handles only — legacy /c/ and /user/ names are NOT channel
 * addresses here (callers resolve those via /api/v1/resolve first).
 */
export function parseChannelId(raw: string): ChannelIdResult {
  const value = (raw ?? "").trim();
  if (STRICT_CHANNEL_ID.test(value)) {
    return { ok: true, value: { kind: "id", value } };
  }
  if (HANDLE.test(value)) {
    return { ok: true, value: { kind: "handle", value } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_channel_id",
      message: "Invalid channel id.",
      hint: "Use a UC channel id (e.g. /api/v1/channels/UC_x5XG1OV2P6uZZ5FSM9Ttw) or an @handle (e.g. /api/v1/channels/@veritasium).",
      status: 400,
    },
  };
}

/** Scope/cache normalization: UC ids verbatim, handles lowercased. */
export function normalizeChannelKey(parsed: ParsedChannelId): string {
  return parsed.kind === "handle" ? parsed.value.toLowerCase() : parsed.value;
}

// ---------------------------------------------------------------------------
// Small tolerant readers (mirror the defensive style of lib/mappers).
// ---------------------------------------------------------------------------

/** Compact counts as served in subscriber/video text: "3.4M", "12K". */
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

/** "12:34" / "1:02:03" duration text -> seconds; anything else -> undefined. */
export function parseDurationText(v: unknown): number | undefined {
  const text = typeof v === "string" ? v : textOf(v);
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
  // Clock components below hours must be < 60 — "1:60" is malformed, not
  // 120s. Hours may be arbitrarily large (multi-hour streams/VODs), but a
  // huge hour value must not overflow to Infinity.
  if (c === undefined) {
    if (b >= 60) {
      return undefined;
    }
    const seconds = a * 60 + b;
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  if (b >= 60 || c >= 60) {
    return undefined;
  }
  const seconds = a * 3600 + b * 60 + c;
  return Number.isFinite(seconds) ? seconds : undefined;
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Collects display labels from a badges array (MetadataBadge/BadgeView). */
function badgeLabels(badges: unknown): string[] {
  if (!Array.isArray(badges)) {
    return [];
  }
  const out: string[] = [];
  for (const b of badges) {
    const r = asRecord(b);
    if (!r) {
      continue;
    }
    const label =
      textOf(r.label) ??
      textOf(r.text) ??
      textOf(r.tooltip) ??
      (typeof r.icon_type === "string" ? r.icon_type : undefined) ??
      (typeof r.icon === "string" ? r.icon : undefined);
    if (label && label.trim() !== "") {
      out.push(label);
    }
  }
  return out;
}

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? "");
}

// ---------------------------------------------------------------------------
// Profile DTO.
// ---------------------------------------------------------------------------

export interface ChannelProfileDTO {
  id: string;
  handle?: string;
  title: string;
  avatar?: Thumbnail[];
  banner?: Thumbnail[];
  subscriberCount?: number;
  videoCount?: number;
  description?: string;
  verified: boolean;
  /** Official-artist badge (music channels). */
  artistBadge?: boolean;
  /** Non-verified custom badge labels, when the header carries any. */
  customBadges?: string[];
}

/**
 * Maps a getChannel Channel object to a stable profile DTO. Reads the three
 * header variants (C4TabbedHeader, InteractiveTabbedHeader, PageHeader) plus
 * the merged ChannelMetadata/MicroformatData — whichever the client served.
 * Returns null when the payload carries no usable channel identity at all.
 */
export function mapChannelProfile(
  channel: unknown,
  fallbackId?: string,
): ChannelProfileDTO | null {
  const root = asRecord(channel);
  if (!root) {
    return null;
  }
  const header = asRecord(root.header);
  const metadata = asRecord(root.metadata);
  const author = asRecord(header?.author);
  if (!header && !metadata) {
    return null;
  }

  const id =
    (typeof header?.channel_id === "string" && header.channel_id) ||
    (typeof author?.id === "string" && author.id) ||
    (typeof metadata?.external_id === "string" && metadata.external_id) ||
    (typeof root.id === "string" && root.id) ||
    fallbackId ||
    undefined;
  if (!id) {
    return null;
  }

  const title =
    (typeof author?.name === "string" && author.name) ||
    textOf(author?.name) ||
    textOf(header?.title) ||
    textOf(metadata?.title) ||
    (typeof header?.page_title === "string" && header.page_title) ||
    undefined;
  if (!title) {
    return null;
  }

  const headerContent = asRecord(header?.content);
  const headerImage = asRecord(header?.image);
  const dto: ChannelProfileDTO = { id, title, verified: false };

  // Handle: explicit channel_handle, else the @suffix of vanity_channel_url.
  const handleText = textOf(header?.channel_handle);
  const vanity =
    typeof metadata?.vanity_channel_url === "string"
      ? metadata.vanity_channel_url
      : undefined;
  const vanityHandle = vanity?.match(/@[^/]+$/)?.[0];
  if (handleText && HANDLE.test(handleText)) {
    dto.handle = handleText;
  } else if (vanityHandle && HANDLE.test(vanityHandle)) {
    dto.handle = vanityHandle;
  }

  const avatar = firstThumbs(
    metadata?.avatar,
    metadata?.thumbnail,
    headerImage,
    header?.avatar,
    author?.thumbnails,
    author?.avatar,
  );
  if (avatar) {
    dto.avatar = avatar;
  }
  const banner = firstThumbs(
    header?.banner,
    header?.tv_banner,
    header?.mobile_banner,
    metadata?.banner,
  );
  if (banner) {
    dto.banner = banner;
  }

  const subscribers = parseCountText(
    header?.subscribers ??
      header?.subscriber_count_text ??
      metadata?.subscribers,
  );
  if (subscribers !== undefined) {
    dto.subscriberCount = Math.round(subscribers);
  }
  const videos = parseCountText(
    header?.videos_count ?? header?.video_count_text ?? metadata?.videos_count,
  );
  if (videos !== undefined) {
    dto.videoCount = Math.round(videos);
  }

  const description =
    textOf(metadata?.description) ??
    textOf(header?.description) ??
    textOf(headerContent?.description) ??
    textOf(asRecord(header?.tagline)?.content);
  if (description) {
    dto.description = description.slice(0, 5000);
  }

  // Badges: Author booleans are the reliable signal; label/icon scan covers
  // header badge arrays on clients that omit them.
  const labels = [
    ...badgeLabels(author?.badges),
    ...badgeLabels(header?.badges),
    ...badgeLabels(metadata?.badges),
  ];
  const verified =
    author?.is_verified === true || labels.some((l) => /verif|check/i.test(l));
  dto.verified = verified;
  if (
    author?.is_verified_artist === true ||
    labels.some((l) => /artist/i.test(l))
  ) {
    dto.artistBadge = true;
  }
  const custom = [
    ...new Set(labels.filter((l) => !/verif|check|artist/i.test(l))),
  ];
  if (custom.length > 0) {
    dto.customBadges = custom.slice(0, 20);
  }

  return dto;
}

// ---------------------------------------------------------------------------
// Feed DTOs with type-leakage guards.
// ---------------------------------------------------------------------------

export interface ChannelVideoDTO {
  id: string;
  title: string;
  thumbnails?: Thumbnail[];
  durationSeconds?: number;
  publishedText?: string;
  viewText?: string;
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

/** LockupView basics shared by the video/shorts/stream mappers. */
function lockupBasics(n: Record<string, unknown>): {
  id: string | undefined;
  title: string;
  thumbnails: Thumbnail[] | undefined;
} {
  const metadata = asRecord(n.metadata);
  const inner = asRecord(metadata?.metadata);
  return {
    id:
      typeof n.content_id === "string" && n.content_id
        ? n.content_id
        : undefined,
    title:
      textOf(metadata?.title) ??
      textOf(inner?.title) ??
      textOf(n.title) ??
      "Untitled",
    thumbnails: firstThumbs(
      asRecord(n.content_image)?.thumbnails,
      n.thumbnails,
      n.thumbnail,
    ),
  };
}

/**
 * LockupView stat rows shared by the video mapper: lockups carry duration /
 * published / view text at the top level or nested in metadata views,
 * depending on the client — whichever shape is served wins.
 */
function lockupStats(n: Record<string, unknown>): {
  durationSeconds?: number;
  publishedText?: string;
  viewText?: string;
} {
  const metadata = asRecord(n.metadata);
  const inner = asRecord(metadata?.metadata);
  const out: {
    durationSeconds?: number;
    publishedText?: string;
    viewText?: string;
  } = {};
  const duration =
    parseDurationText(n.length_text) ??
    parseDurationText(n.duration) ??
    parseDurationText(metadata?.length_text ?? metadata?.duration) ??
    parseDurationText(inner?.length_text ?? inner?.duration);
  if (duration !== undefined) {
    out.durationSeconds = Math.round(duration);
  }
  const published =
    textOf(n.published) ??
    textOf(metadata?.published) ??
    textOf(inner?.published);
  if (published) {
    out.publishedText = published;
  }
  const views =
    textOf(n.view_count ?? n.short_view_count ?? n.views) ??
    textOf(
      metadata?.view_count ?? metadata?.short_view_count ?? metadata?.views,
    ) ??
    textOf(inner?.view_count ?? inner?.short_view_count ?? inner?.views);
  if (views) {
    out.viewText = views;
  }
  return out;
}

/**
 * Long-form only: Video/GridVideo/CompactVideo, plus LockupView with
 * content_type VIDEO. ReelItem/ShortsLockupView/LockupView(SHORT) and
 * playlist/channel nodes map to null and are dropped by callers.
 */
export function mapChannelVideo(node: unknown): ChannelVideoDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const isLockup = type.toLowerCase() === "lockupview";
  if (isLockup) {
    if (String(n.content_type ?? "").toUpperCase() !== "VIDEO") {
      return null;
    }
    const base = lockupBasics(n);
    if (!base.id) {
      return null;
    }
    const dto: ChannelVideoDTO = { id: base.id, title: base.title };
    if (base.thumbnails) {
      dto.thumbnails = base.thumbnails;
    }
    const stats = lockupStats(n);
    if (stats.durationSeconds !== undefined) {
      dto.durationSeconds = stats.durationSeconds;
    }
    if (stats.publishedText !== undefined) {
      dto.publishedText = stats.publishedText;
    }
    if (stats.viewText !== undefined) {
      dto.viewText = stats.viewText;
    }
    return dto;
  }
  if (!/video/i.test(type) || /reel|short/i.test(type)) {
    return null;
  }
  const id = videoIdOf(n);
  if (!id) {
    return null;
  }
  const dto: ChannelVideoDTO = {
    id,
    title: textOf(n.title) ?? "Untitled",
  };
  const thumbs = firstThumbs(n.thumbnails, n.thumbnail);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  const duration =
    parseDurationText(n.length_text) ??
    parseDurationText(n.duration) ??
    (typeof asRecord(n.duration)?.seconds === "number"
      ? (asRecord(n.duration)?.seconds as number)
      : undefined);
  if (duration !== undefined) {
    dto.durationSeconds = Math.round(duration);
  }
  const published = textOf(n.published);
  if (published) {
    dto.publishedText = published;
  }
  const views = textOf(n.view_count ?? n.short_view_count ?? n.views);
  if (views) {
    dto.viewText = views;
  }
  return dto;
}

export interface ChannelShortDTO {
  id: string;
  title: string;
  thumbnails?: Thumbnail[];
  viewText?: string;
}

/**
 * Shorts only: ReelItem, ShortsLockupView, plus LockupView with
 * content_type SHORT. Long-form Video/GridVideo/CompactVideo (and
 * LockupView VIDEO) map to null — no long-form inside `shorts`.
 */
export function mapChannelShort(node: unknown): ChannelShortDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const lower = type.toLowerCase();
  if (lower === "lockupview") {
    if (String(n.content_type ?? "").toUpperCase() !== "SHORT") {
      return null;
    }
    const base = lockupBasics(n);
    if (!base.id) {
      return null;
    }
    const dto: ChannelShortDTO = { id: base.id, title: base.title };
    if (base.thumbnails) {
      dto.thumbnails = base.thumbnails;
    }
    return dto;
  }
  if (lower === "reelitem") {
    const id = videoIdOf(n);
    if (!id) {
      return null;
    }
    const dto: ChannelShortDTO = {
      id,
      title: textOf(n.title) ?? "Untitled",
    };
    const thumbs = firstThumbs(n.thumbnails, n.thumbnail);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    const views = textOf(n.views ?? n.view_count ?? n.short_view_count);
    if (views) {
      dto.viewText = views;
    }
    return dto;
  }
  if (lower === "shortslockupview") {
    const overlay = asRecord(n.overlay_metadata);
    const tapPayload = asRecord(asRecord(n.on_tap_endpoint)?.payload);
    const tapId =
      (typeof tapPayload?.videoId === "string" && tapPayload.videoId) ||
      (typeof tapPayload?.video_id === "string" && tapPayload.video_id) ||
      undefined;
    // entity_id is deliberately excluded: on some clients it is an opaque
    // collection id, not a watch id — emitting it would hand callers an
    // unplayable id. Only real video/watch ids qualify, else null.
    const watchId =
      (typeof n.video_id === "string" && n.video_id) ||
      (typeof n.id === "string" && n.id) ||
      (typeof n.content_id === "string" && n.content_id) ||
      undefined;
    const id = tapId ?? watchId;
    if (!id) {
      return null;
    }
    const dto: ChannelShortDTO = {
      id,
      title:
        textOf(overlay?.primary_text) ??
        ((typeof n.accessibility_text === "string" && n.accessibility_text) ||
          textOf(n.title)) ??
        "Untitled",
    };
    const thumbs = firstThumbs(n.thumbnail, n.thumbnails);
    if (thumbs) {
      dto.thumbnails = thumbs;
    }
    const views = textOf(overlay?.secondary_text);
    if (views) {
      dto.viewText = views;
    }
    return dto;
  }
  return null;
}

export interface ChannelStreamDTO {
  id: string;
  title: string;
  thumbnails?: Thumbnail[];
  /** True while currently live. */
  isLive: boolean;
  /** True while scheduled/premiere-waiting (not yet live). */
  isUpcoming: boolean;
  /** ISO timestamp when the upcoming stream starts, when known. */
  scheduledStart?: string;
  /** Live viewer text ("1.2K watching") while live, when served. */
  viewersText?: string;
  viewText?: string;
  publishedText?: string;
  durationSeconds?: number;
}

function isLiveNode(n: Record<string, unknown>): boolean {
  if (n.is_live === true) {
    return true;
  }
  const labels = [...badgeLabels(n.badges), ...badgeLabels(n.author_badges)];
  if (labels.some((l) => /^\s*live\s*$/i.test(l) || /watching/i.test(l))) {
    return true;
  }
  const views = textOf(n.view_count ?? n.short_view_count ?? n.views);
  if (views && /watching/i.test(views)) {
    return true;
  }
  const style = typeof n.style === "string" ? n.style : "";
  return /live_post/i.test(style);
}

function upcomingOf(n: Record<string, unknown>): Date | string | undefined {
  const u = n.upcoming;
  if (u instanceof Date && !Number.isNaN(u.getTime())) {
    return u;
  }
  if (typeof u === "string" && u !== "") {
    return u;
  }
  return undefined;
}

function isUpcomingNode(n: Record<string, unknown>): boolean {
  if (n.is_upcoming === true) {
    return true;
  }
  if (upcomingOf(n) !== undefined) {
    return true;
  }
  if (textOf(n.upcoming_text)) {
    return true;
  }
  if (n.is_reminder_set === true) {
    return true;
  }
  const labels = [...badgeLabels(n.badges), ...badgeLabels(n.author_badges)];
  if (labels.some((l) => /upcoming|premiere|schedul|reminder|notif/i.test(l))) {
    return true;
  }
  return /premiere/i.test(typeof n.style === "string" ? n.style : "");
}

/**
 * Fills live-state fields shared by both stream branches: isLive/isUpcoming
 * detection, scheduled start, viewer vs view text, published text, and
 * duration (suppressed while live — a live duration is a moving target).
 */
function finishStreamDTO(
  n: Record<string, unknown>,
  dto: ChannelStreamDTO,
): ChannelStreamDTO {
  const isLive = isLiveNode(n);
  dto.isLive = isLive;
  dto.isUpcoming = !isLive && isUpcomingNode(n);
  const upcoming = upcomingOf(n);
  if (upcoming instanceof Date) {
    dto.scheduledStart = upcoming.toISOString();
  } else if (typeof upcoming === "string") {
    dto.scheduledStart = upcoming;
  }
  // Stats may sit at the top level or nested in lockup metadata views —
  // lockupStats covers both shapes (same paths as the video mapper).
  const stats = lockupStats(n);
  if (stats.viewText) {
    if (isLive && /watching/i.test(stats.viewText)) {
      dto.viewersText = stats.viewText;
    } else {
      dto.viewText = stats.viewText;
    }
  }
  if (stats.publishedText) {
    dto.publishedText = stats.publishedText;
  }
  if (stats.durationSeconds !== undefined && !isLive) {
    dto.durationSeconds = stats.durationSeconds;
  }
  return dto;
}

/**
 * Live/upcoming/past: Video/GridVideo/CompactVideo in any live state, plus
 * LockupView VIDEO (past streams read as plain videos) and LockupView LIVE
 * (live/upcoming badges run through the same isLive/isUpcoming detection —
 * never hardcoded). Shorts-shaped nodes (ReelItem/ShortsLockupView/LockupView
 * SHORT) and playlist/channel nodes map to null. Every item carries
 * isLive/isUpcoming; scheduled start and viewer counts are included where
 * the node serves them.
 */
export function mapChannelStream(node: unknown): ChannelStreamDTO | null {
  const n = asRecord(node);
  if (!n) {
    return null;
  }
  const type = nodeType(n);
  const lower = type.toLowerCase();
  if (lower === "lockupview") {
    const ct = String(n.content_type ?? "").toUpperCase();
    if (ct !== "VIDEO" && ct !== "LIVE") {
      return null;
    }
    const base = lockupBasics(n);
    if (!base.id) {
      return null;
    }
    const dto: ChannelStreamDTO = {
      id: base.id,
      title: base.title,
      isLive: false,
      isUpcoming: false,
    };
    if (base.thumbnails) {
      dto.thumbnails = base.thumbnails;
    }
    return finishStreamDTO(n, dto);
  }
  if (!/video/i.test(type) || /reel|short/i.test(type)) {
    return null;
  }
  const id = videoIdOf(n);
  if (!id) {
    return null;
  }
  const dto: ChannelStreamDTO = {
    id,
    title: textOf(n.title) ?? "Untitled",
    isLive: false,
    isUpcoming: false,
  };
  const thumbs = firstThumbs(n.thumbnails, n.thumbnail);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  return finishStreamDTO(n, dto);
}

// ---------------------------------------------------------------------------
// Error classifier.
// ---------------------------------------------------------------------------

export interface ClassifiedChannelError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

/**
 * Timeouts/aborts -> 504 upstream_timeout; unknown/private/deleted/
 * terminated channels and unresolvable handles -> 404 channel_not_found;
 * everything else -> 502 upstream_degraded. Never leaks stack traces.
 */
export function classifyChannelError(err: unknown): ClassifiedChannelError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Channel lookup timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  if (
    /failed to resolve[ _]url|resolve_url[\s\S]{0,120}(not.?found|\b404\b)|(not.?found|\b404\b)[\s\S]{0,120}resolve_url|channel.{0,60}(not.?found|not found|unavailable|not available|invalid|does.?not.?exist|terminated|private|deleted|removed)|not.?found.{0,40}channel|invalid channel|unknown channel|\b404\b.{0,40}channel|channel.{0,40}\b404\b/i.test(
      raw,
    )
  ) {
    return {
      code: "channel_not_found",
      message: "Channel not found or unavailable.",
      hint: "Check the channel id or @handle, or resolve the URL via /api/v1/resolve first.",
      status: 404,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Channel lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

// ---------------------------------------------------------------------------
// Tab adapter: Channel / ChannelListContinuation -> ContinuationSearch.
// ---------------------------------------------------------------------------

/**
 * Adapts a channel tab page to the generic continuation-page shape. Real
 * Channel and ChannelListContinuation objects both expose the Feed `videos`
 * getter (memo-flattened video-ish nodes), `has_continuation`, and an
 * immutable `getContinuation()` — the same contract Search/Comments adapt.
 * A tab with no items (or a missing tab, adapted by callers as an empty
 * page) yields a terminal empty page, never a 404.
 */
export function adaptChannelTab(feed: {
  videos?: { [Symbol.iterator](): Iterator<unknown> } | null;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  // A truthy-but-non-iterable `videos` (partial mocks, client drift) is an
  // empty page — never a spread TypeError turned 500.
  const results =
    feed.videos !== null &&
    feed.videos !== undefined &&
    typeof feed.videos[Symbol.iterator] === "function"
      ? [...feed.videos]
      : [];
  return {
    results,
    has_continuation: feed.has_continuation,
    getContinuation: async () =>
      adaptChannelTab(
        (await feed.getContinuation()) as Parameters<typeof adaptChannelTab>[0],
      ),
  };
}

/** Terminal empty tab page (missing tab, e.g. no shorts/live shelf). */
export function emptyChannelTab(): ContinuationSearch {
  return {
    results: [],
    has_continuation: false,
    getContinuation: async () => emptyChannelTab(),
  };
}

// ---------------------------------------------------------------------------
// Shared channel deps seams (defaults live in route files via lazy import).
// ---------------------------------------------------------------------------

export interface ChannelProfileDeps {
  /** UC id or @handle -> canonical UC channel id (handles via resolveURL). */
  resolveChannelId: (input: string) => Promise<string>;
  /** Canonical UC id -> raw getChannel payload for mapChannelProfile. */
  fetchProfile: (channelId: string) => Promise<unknown>;
}

export type ChannelFeedKind = "videos" | "shorts" | "streams";

/**
 * Pure has_* tab guard shared by the feed fetchers. An explicit `false`
 * (channel genuinely has no such tab) skips the tab call and yields a
 * terminal empty page; `true` or unknown (partial payloads, client drift)
 * proceeds to the guarded tab call, whose missing-method fallback still
 * yields a terminal empty page rather than throwing.
 */
export function hasChannelTab(
  channel: {
    has_videos?: boolean;
    has_shorts?: boolean;
    has_live_streams?: boolean;
  },
  kind: ChannelFeedKind,
): boolean {
  const flag =
    kind === "videos"
      ? channel.has_videos
      : kind === "shorts"
        ? channel.has_shorts
        : channel.has_live_streams;
  return flag !== false;
}

export interface ChannelFeedDeps {
  /** UC id or @handle -> canonical UC channel id (handles via resolveURL). */
  resolveChannelId: (input: string) => Promise<string>;
  /** Canonical UC id -> adapted first tab page (or terminal empty page). */
  fetchFirstPage: (channelId: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

function feedMapper(kind: ChannelFeedKind) {
  return kind === "videos"
    ? mapChannelVideo
    : kind === "shorts"
      ? mapChannelShort
      : mapChannelStream;
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// channel feeds are locale-independent. The address is resolved to its
// canonical UC id BEFORE caching (on both first-page and cursor paths), so
// @handle and UC form share one scope, one cache entry, and interoperable
// cursors.
export async function handleChannelFeed(
  req: NextRequest,
  rawId: string,
  kind: ChannelFeedKind,
  deps: ChannelFeedDeps,
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
    return errorResponse(requestId, {
      code: "invalid_limit",
      message: "Invalid limit.",
      hint: "Use an integer between 1 and 50; defaults to 20.",
      status: 400,
    });
  }

  const mapItem = feedMapper(kind);
  const cursor = params.get("cursor");

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
    const scope = `channel:${kind}:${channelId}`;

    // Cursor requests skip re-fetching page 1 — only limit/region/lang
    // apply. Unknown/expired cursors yield [] + next: null, never an error.
    if (cursor) {
      return serveChannelContinuation(
        requestId,
        region,
        lang,
        scope,
        cursor,
        limit,
        mapItem,
        deps,
      );
    }

    const cacheKey = `channel:${kind}:v1:${channelId}:${limit}`;
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: Array<ChannelVideoDTO | ChannelShortDTO | ChannelStreamDTO>;
      forkFrom: string | null;
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const page = await deps.fetchFirstPage(channelId);
        const items = page.results
          .slice(0, limit)
          .map(mapItem)
          .filter((d): d is NonNullable<typeof d> => d !== null);
        const forkFrom = storeContinuation(page, limit, scope);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeout/429/5xx) may. Not-found propagates below.
      (err) => classifyChannelError(err).code !== "channel_not_found",
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, scope);
    // Cursors are process-local (see src/lib/continuations.ts): a response
    // carrying one must never sit in the shared CDN, or a replay on another
    // instance resolves it to [] + next: null. Only exhausted first pages
    // (next == null, no cursor involved) keep the public TTL. Cursor-paged
    // requests always take the serveContinuation branch above (no-store).
    const cursorRequested = cursor !== null;
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
        next !== null || cursorRequested
          ? CACHE_CONTROL.noStore
          : CACHE_CONTROL.channelFeed,
    });
  } catch (err) {
    return errorResponse(requestId, classifyChannelError(err));
  }
}

async function serveChannelContinuation(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  mapItem: (
    node: unknown,
  ) => ChannelVideoDTO | ChannelShortDTO | ChannelStreamDTO | null,
  deps: ChannelFeedDeps,
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
      .map(mapItem)
      .filter((d): d is NonNullable<typeof d> => d !== null);
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
    const nextPage = await deps.continueFeed(entry.search);
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapItem)
      .filter((d): d is NonNullable<typeof d> => d !== null);
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

// ---------------------------------------------------------------------------
// Shared profile handler.
// ---------------------------------------------------------------------------

export async function handleChannelProfile(
  req: NextRequest,
  rawId: string,
  deps: ChannelProfileDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  const parsed = parseChannelId(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }

  try {
    // Handles resolve to a canonical UC id first, so the profile cache key
    // is always the UC id — @handle and UC form share one L0 entry.
    const channelId = await deps.resolveChannelId(parsed.value.value);
    const cacheKey = `channel:profile:v1:${channelId}`;
    const result = await cached<ChannelProfileDTO>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
      async () => {
        const raw = await deps.fetchProfile(channelId);
        const dto = mapChannelProfile(raw, channelId);
        if (!dto) {
          throw new Error(`channel_not_found: ${channelId}`);
        }
        return dto;
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeout/429/5xx) may. Not-found propagates below.
      (err) => classifyChannelError(err).code !== "channel_not_found",
    );
    return successResponse(result.value, {
      requestId,
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
      cacheControl: CACHE_CONTROL.staticish,
    });
  } catch (err) {
    return errorResponse(requestId, classifyChannelError(err));
  }
}
