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
