// Pure DTO mappers for youtubei.js nodes — defensive by design because
// node shapes vary across clients. No imports from lib/youtube so these
// stay unit-testable without network. All inputs/outputs use `any`-tolerant
// access; unknown node types map to null and are dropped by callers.

export type SearchKind = "video" | "channel" | "playlist";

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface SearchResultDTO {
  id: string;
  kind: SearchKind;
  title: string;
  channel?: { id?: string; name?: string };
  thumbnails?: Thumbnail[];
  durationSeconds?: number;
  publishedText?: string;
}

export interface VideoDetailsDTO {
  id: string;
  title: string;
  channel: { id?: string; name?: string };
  description?: string;
  durationSeconds?: number;
  viewCount?: number;
  thumbnails?: Thumbnail[];
  keywords?: string[];
}

/** Extracts display text from youtubei Text objects, runs, or plain strings. */
export function textOf(t: unknown): string | undefined {
  if (t === null || t === undefined) {
    return undefined;
  }
  if (typeof t === "string") {
    return t;
  }
  if (typeof t === "object") {
    const obj = t as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (Array.isArray(obj.runs)) {
      const joined = (obj.runs as Array<unknown>)
        .map((r) =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as Record<string, unknown>).text === "string"
            ? ((r as Record<string, unknown>).text as string)
            : "",
        )
        .join("");
      return joined === "" ? undefined : joined;
    }
    if (typeof obj.title === "string") {
      return obj.title;
    }
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    if (cleaned === "") {
      return undefined;
    }
    // Compact suffixes as served in view/subscriber text: "3.4M", "12K".
    const compact = cleaned.match(/^([\d.]+)\s*([KMB])\b/i);
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
    const digits = cleaned.replace(/[^0-9.]/g, "");
    if (digits === "") {
      return undefined;
    }
    const n = Number(digits);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeThumbnails(v: unknown): Thumbnail[] | undefined {
  const list = Array.isArray(v)
    ? v
    : (v as { thumbnails?: unknown })?.thumbnails;
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

function detectKind(node: Record<string, unknown>): SearchKind | null {
  const raw = String(node.type ?? "").toLowerCase();
  if (raw.includes("channel")) {
    return "channel";
  }
  if (raw.includes("playlist") || raw.includes("mix")) {
    return "playlist";
  }
  if (
    raw.includes("video") ||
    raw.includes("movie") ||
    raw.includes("reel") ||
    raw === "short"
  ) {
    return "video";
  }
  return null;
}

/** Maps one raw search node to a stable DTO; null = unsupported node. */
export function mapSearchItem(node: unknown): SearchResultDTO | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const n = node as Record<string, unknown>;
  const kind = detectKind(n);
  if (!kind) {
    return null;
  }
  const id =
    (typeof n.id === "string" && n.id) ||
    (typeof n.video_id === "string" && n.video_id) ||
    (typeof n.playlist_id === "string" && n.playlist_id) ||
    (typeof n.channel_id === "string" && n.channel_id) ||
    undefined;
  if (!id) {
    return null;
  }
  const dto: SearchResultDTO = {
    id,
    kind,
    title: textOf(n.title) ?? "Untitled",
  };
  const author = n.author as Record<string, unknown> | undefined;
  const authorName =
    typeof author === "object" && author !== null
      ? textOf(author.name)
      : undefined;
  if (authorName) {
    dto.channel = {
      id: typeof author?.id === "string" ? author.id : undefined,
      name: authorName,
    };
  }
  const thumbs = normalizeThumbnails(n.thumbnails ?? n.thumbnail);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  const duration =
    toNumber((n.duration as Record<string, unknown> | undefined)?.seconds) ??
    toNumber(n.duration) ??
    toNumber(n.length_seconds);
  if (duration !== undefined) {
    dto.durationSeconds = Math.round(duration);
  }
  const published =
    textOf(n.published) ??
    textOf((n.published as Record<string, unknown> | undefined)?.text);
  if (published) {
    dto.publishedText = published;
  }
  return dto;
}

/** Maps a getBasicInfo/getInfo payload to a stable video DTO. */
export function mapVideoDetails(info: unknown): VideoDetailsDTO {
  const root = (info ?? {}) as Record<string, unknown>;
  const basic = (root.basic_info ?? root ?? {}) as Record<string, unknown>;
  const channelObj = (basic.channel ?? {}) as Record<string, unknown>;

  const id =
    (typeof basic.id === "string" && basic.id) ||
    (typeof root.id === "string" && root.id) ||
    "unknown";

  const dto: VideoDetailsDTO = {
    id,
    title: textOf(basic.title) ?? "Untitled",
    channel: {
      id: typeof basic.channel_id === "string" ? basic.channel_id : undefined,
      name: textOf(channelObj.name) ?? textOf(basic.author) ?? undefined,
    },
  };

  const description = textOf(basic.description ?? basic.short_description);
  if (description) {
    dto.description = description.slice(0, 5000);
  }
  const duration =
    toNumber(basic.duration) ??
    toNumber((basic as Record<string, unknown>).length_seconds);
  if (duration !== undefined) {
    dto.durationSeconds = Math.round(duration);
  }
  const views =
    toNumber(basic.view_count) ??
    toNumber((basic as Record<string, unknown>).view_count_text);
  if (views !== undefined) {
    dto.viewCount = Math.round(views);
  }
  const thumbs = normalizeThumbnails(basic.thumbnails ?? basic.thumbnail);
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  if (Array.isArray(basic.keywords)) {
    const kws = (basic.keywords as unknown[]).filter(
      (k): k is string => typeof k === "string",
    );
    if (kws.length > 0) {
      dto.keywords = kws.slice(0, 50);
    }
  }
  return dto;
}

export interface RelatedItemDTO {
  id: string;
  kind: SearchKind;
  title: string;
  channel?: { id?: string; name?: string };
  thumbnails?: Thumbnail[];
  durationSeconds?: number;
  viewText?: string;
  publishedText?: string;
}

function detectLockupKind(contentType: string): SearchKind | null {
  const raw = contentType.toUpperCase();
  if (
    raw === "VIDEO" ||
    raw === "SHORT" ||
    raw === "MOVIE" ||
    raw === "CLIP" ||
    raw === "LIVE" ||
    raw === "PODCAST"
  ) {
    return "video";
  }
  if (
    raw === "PLAYLIST" ||
    raw === "ALBUM" ||
    raw === "STATION" ||
    raw === "MIX"
  ) {
    return "playlist";
  }
  if (raw === "CHANNEL" || raw === "ARTIST") {
    return "channel";
  }
  return null;
}

/** Maps a LockupView node (watch-next rail) to a stable DTO. */
function mapLockupItem(n: Record<string, unknown>): RelatedItemDTO | null {
  const id =
    typeof n.content_id === "string" && n.content_id ? n.content_id : undefined;
  const kind =
    typeof n.content_type === "string"
      ? detectLockupKind(n.content_type)
      : null;
  if (!id || !kind) {
    return null;
  }
  const metadata = (n.metadata ?? {}) as Record<string, unknown>;
  const dto: RelatedItemDTO = {
    id,
    kind,
    title: textOf(metadata.title) ?? textOf(n.title) ?? "Untitled",
  };
  // Channel + stats live in nested metadata views; attempt a few known paths
  // and omit when absent rather than guessing.
  const inner = (metadata.metadata ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(inner.metadata_rows)
    ? (inner.metadata_rows as Array<Record<string, unknown>>)
    : Array.isArray(inner.rows)
      ? (inner.rows as Array<Record<string, unknown>>)
      : [];
  for (const row of rows) {
    const runs = (row.runs ?? row.text ?? row) as unknown;
    const t = textOf(runs) ?? textOf(row);
    if (!t) {
      continue;
    }
    if (dto.channel === undefined && !/view|ago|streamed/i.test(t)) {
      dto.channel = { name: t };
    } else if (dto.viewText === undefined && /view|watching/i.test(t)) {
      dto.viewText = t;
    } else if (
      dto.publishedText === undefined &&
      /ago|streamed|live/i.test(t)
    ) {
      dto.publishedText = t;
    }
  }
  const image = (n.content_image ?? {}) as Record<string, unknown>;
  const thumbs = normalizeThumbnails(
    image.thumbnails ?? image.thumbnail ?? n.thumbnails ?? n.thumbnail,
  );
  if (thumbs) {
    dto.thumbnails = thumbs;
  }
  return dto;
}

/**
 * Maps one raw watch-next node to a stable DTO; null = unsupported node.
 * CompactVideo/Video shapes overlap search nodes, so they delegate to
 * mapSearchItem (plus viewText); LockupView nodes carry content_id /
 * content_type instead and are handled above.
 */
export function mapRelatedItem(node: unknown): RelatedItemDTO | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.content_id === "string") {
    return mapLockupItem(n);
  }
  const base = mapSearchItem(node);
  if (!base) {
    return null;
  }
  const dto: RelatedItemDTO = { ...base };
  const viewText =
    textOf(n.view_count) ??
    textOf(n.short_view_count) ??
    textOf(n.view_count_text);
  if (viewText) {
    dto.viewText = viewText;
  }
  return dto;
}

export interface CommentDTO {
  id: string;
  author: { name?: string; id?: string };
  text: string;
  likeCount?: number;
  publishedText?: string;
  replyCount?: number;
  isPinned?: boolean;
}

/** Maps a CommentThread (or bare CommentView) to a stable DTO. */
export function mapComment(thread: unknown): CommentDTO | null {
  if (typeof thread !== "object" || thread === null) {
    return null;
  }
  const t = thread as Record<string, unknown>;
  const c = (
    typeof t.comment === "object" && t.comment !== null ? t.comment : t
  ) as Record<string, unknown>;
  const id =
    (typeof c.comment_id === "string" && c.comment_id) ||
    (typeof t.comment_id === "string" && t.comment_id) ||
    undefined;
  if (!id) {
    return null;
  }
  const author = (c.author ?? {}) as Record<string, unknown>;
  const dto: CommentDTO = {
    id,
    author: {
      name:
        (typeof author.name === "string" && author.name) ||
        textOf(author.name) ||
        textOf(author.title) ||
        undefined,
      id: typeof author.id === "string" ? author.id : undefined,
    },
    text: textOf(c.content) ?? textOf(c.text) ?? "",
  };
  const likes = toNumber(c.like_count ?? c.likes);
  if (likes !== undefined) {
    dto.likeCount = Math.round(likes);
  }
  const published =
    (typeof c.published_time === "string" && c.published_time) ||
    textOf(c.published_time) ||
    textOf(c.published);
  if (published) {
    dto.publishedText = published;
  }
  const replies = toNumber(c.reply_count ?? c.replies_count);
  if (replies !== undefined) {
    dto.replyCount = Math.round(replies);
  }
  if (typeof c.is_pinned === "boolean") {
    dto.isPinned = c.is_pinned;
  } else if (
    t.is_pinned === true ||
    (t.rendering_priority as string) === "RENDERING_PRIORITY_PINNED_COMMENT"
  ) {
    dto.isPinned = true;
  }
  return dto;
}

export interface CaptionTrackDTO {
  languageCode: string;
  name?: string;
  kind: "manual" | "auto";
  isTranslatable?: boolean;
}

/** Maps one raw caption track (kind "asr" = auto-generated). */
export function mapCaptionTrack(track: unknown): CaptionTrackDTO | null {
  if (typeof track !== "object" || track === null) {
    return null;
  }
  const o = track as Record<string, unknown>;
  const languageCode =
    typeof o.language_code === "string" && o.language_code
      ? o.language_code
      : undefined;
  if (!languageCode) {
    return null;
  }
  const dto: CaptionTrackDTO = {
    languageCode,
    kind: o.kind === "asr" ? "auto" : "manual",
  };
  const name = textOf(o.name);
  if (name) {
    dto.name = name;
  }
  if (typeof o.is_translatable === "boolean") {
    dto.isTranslatable = o.is_translatable;
  }
  return dto;
}

/** Maps a raw captions container (info.captions) to track DTOs. */
export function mapCaptionList(captions: unknown): CaptionTrackDTO[] {
  if (typeof captions !== "object" || captions === null) {
    return [];
  }
  const tracks = (captions as Record<string, unknown>).caption_tracks;
  if (!Array.isArray(tracks)) {
    return [];
  }
  return tracks
    .map(mapCaptionTrack)
    .filter((d): d is CaptionTrackDTO => d !== null);
}

export interface TranscriptSegmentDTO {
  startSeconds: number;
  durationSeconds?: number;
  text: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Maps one raw transcript segment (start_ms/end_ms + snippet). */
export function mapTranscriptSegment(
  seg: unknown,
): TranscriptSegmentDTO | null {
  if (typeof seg !== "object" || seg === null) {
    return null;
  }
  const o = seg as Record<string, unknown>;
  const startMs = toNumber(o.start_ms);
  const start =
    startMs !== undefined
      ? startMs / 1000
      : (toNumber(o.startSeconds) ?? toNumber(o.start_seconds));
  if (start === undefined || !Number.isFinite(start) || start < 0) {
    return null;
  }
  const text = textOf(o.snippet) ?? textOf(o.text) ?? "";
  if (text.trim() === "") {
    return null;
  }
  const dto: TranscriptSegmentDTO = { startSeconds: round3(start), text };
  const endMs = toNumber(o.end_ms);
  if (endMs !== undefined && endMs / 1000 > start) {
    dto.durationSeconds = round3(endMs / 1000 - start);
  } else {
    const dur = toNumber(o.durationSeconds) ?? toNumber(o.duration_seconds);
    if (dur !== undefined && dur > 0) {
      dto.durationSeconds = round3(dur);
    }
  }
  return dto;
}

/**
 * Maps a TranscriptInfo payload to segment DTOs. Navigates
 * transcript.content.body.initial_segments (section headers carry no snippet
 * and are dropped); plain-shape mocks with the same nesting work too.
 */
export function mapTranscriptInfo(info: unknown): TranscriptSegmentDTO[] {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const root = info as Record<string, unknown>;
  const transcript = (root.transcript ?? root) as Record<string, unknown>;
  const content = (transcript.content ?? {}) as Record<string, unknown>;
  const body = (content.body ?? {}) as Record<string, unknown>;
  const segments = body.initial_segments;
  if (!Array.isArray(segments)) {
    return [];
  }
  return segments
    .map(mapTranscriptSegment)
    .filter((d): d is TranscriptSegmentDTO => d !== null);
}

export interface ClassifiedVideoError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

/**
 * Distinguishes: NOT_FOUND/private/deleted/video-unavailable -> 404
 * video_not_found; LOGIN_REQUIRED/bot-guard -> 502 upstream_degraded;
 * timeouts/aborts -> 504 upstream_timeout; everything else -> 502
 * upstream_degraded. "Unavailable" alone stays 502 — only video-scoped
 * wording ("this video is unavailable") is a definitive 404.
 * Never leaks stack traces — callers use only these four fields.
 */
export function classifyVideoError(err: unknown): ClassifiedVideoError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (
    /login_required|login required|botguard|bot-guard|sign in|protected/i.test(
      raw,
    )
  ) {
    return {
      code: "upstream_degraded",
      message: "YouTube requires sign-in for this video.",
      hint: "Retry later or try a different video; include X-Request-Id in bug reports.",
      status: 502,
    };
  }
  if (
    /not_found|not found|\b404\b|video.{0,40}unavailable|unavailable.{0,40}video|private|deleted|removed/i.test(
      raw,
    )
  ) {
    return {
      code: "video_not_found",
      message: "Video not found or unavailable.",
      hint: "Check the video id, or resolve the URL via /api/v1/resolve first.",
      status: 404,
    };
  }
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: "Upstream request timed out.",
      hint: "Retry the request; include X-Request-Id in bug reports if it persists.",
      status: 504,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Video lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

/**
 * Related/comments feeds ride on a video id, so feed failures classify like
 * video failures: unknown/private/deleted -> 404 video_not_found; timeouts
 * -> 504 upstream_timeout; everything else -> 502 upstream_degraded.
 * Comments-disabled upstreams get their own 404 so callers can hide the
 * panel instead of reporting a missing video; that check runs first so a
 * message carrying both signals still hides the panel. youtubei throws
 * "The comments page did not have any content" when the video id does not
 * resolve; an existing video with zero comments returns an empty feed
 * (200 data:[] terminal page), never this throw — so it is a missing video.
 * The match is anchored to the exact youtubei "comments page" wording
 * because this classifier is shared with related.
 */
export function classifyFeedError(err: unknown): ClassifiedVideoError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (
    /comments?.*?(disabled|turned.?off|unavailable|not available)/i.test(raw)
  ) {
    return {
      code: "comments_disabled",
      message: "Comments are disabled for this video.",
      hint: "This video has comments disabled; hide the comments panel or fall back to the description.",
      status: 404,
    };
  }
  if (/comments page did not have any content/i.test(raw)) {
    return {
      code: "video_not_found",
      message: "Video not found or unavailable.",
      hint: "Check the video id, or resolve the URL via /api/v1/resolve first.",
      status: 404,
    };
  }
  return classifyVideoError(err);
}

/**
 * Only caption-specific signals -> 404 captions_disabled (never 500).
 * Everything else (private/deleted video, transient failures, timeouts)
 * delegates to classifyVideoError, so callers get video_not_found (404),
 * upstream_timeout (504), or upstream_degraded (502) instead of a
 * misleading captions_disabled.
 */
export function classifyCaptionsError(err: unknown): ClassifiedVideoError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (
    /captions?_disabled|captions?\s+(disabled|unavailable|not available|not found)|no captions?/i.test(
      raw,
    )
  ) {
    return {
      code: "captions_disabled",
      message: "No caption tracks are available for this video.",
      hint: "This video has captions disabled; hide the captions UI or fall back to the description.",
      status: 404,
    };
  }
  return classifyVideoError(err);
}

/**
 * Only transcript-specific signals (missing engagement/transcript panel,
 * transcript continuation, a 4xx get_transcript fetch for an
 * already-resolved video, or disabled captions) -> 404
 * transcript_unavailable with a hint telling callers to hide the panel.
 * get_transcript 5xx/network failures fall through (no 4xx status), so
 * outages still report 502/504 via classifyVideoError, as do private/deleted
 * videos (video_not_found) — never a misleading transcript_unavailable.
 */
export function classifyTranscriptError(err: unknown): ClassifiedVideoError {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (
    /transcript_unavailable|get_transcript.*?status code 4\d\d|transcript\s+(panel|continuation|not found|unavailable|not available)|no transcript|engagement panels?|captions?_disabled|captions?\s+disabled/i.test(
      raw,
    )
  ) {
    return {
      code: "transcript_unavailable",
      message: "No transcript is available for this video.",
      hint: "Captions may be disabled for this video; hide the transcript panel or try a video with manual or auto captions.",
      status: 404,
    };
  }
  return classifyVideoError(err);
}
