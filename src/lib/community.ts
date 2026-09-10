// Phase 8 (Community-enriched data) shared handlers.
// Three crowd-sourced layers no official API offers — SponsorBlock skip
// segments, ReturnYouTubeDislike stats, DeArrow titles/thumbnails — plus one
// combined call composing video detail with all three. Third-party fetches
// run behind the 8s fail-fast, ride the L0 + L1 cache ladder (CDN +
// in-memory only, no durable store), and degrade per-source: a cold-miss
// failure is a typed 502/504 on the single-source routes, while `combined`
// answers 200 with null/[] parts plus a warnings entry — except a
// definitively missing video, which stays a 404 like GET /videos/:id.
//
// Upstream choices (per the Phase 8 brief):
// - sponsors: sponsor.ajay.app skipSegments, categories sponsor/intro/outro/
//   interaction/selfpromo/music_offtopic, actionType=skip. Upstream 404 means
//   "no segments submitted" and maps to [], never an error.
// - dislikes: returnyoutubedislikeapi.com votes (lowercase d), fields mapped
//   1:1. Upstream 404 means "no stats" and maps to null + a warning.
// - dearrow: sponsor.ajay.app branding; the top-voted non-original title wins
//   and thumbnails resolve to dearrow-thumb URLs. No usable crowd entry maps
//   to null + a warning.

import type { NextRequest, NextResponse } from "next/server";
import { type CachedResult, cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  type ClassifiedVideoError,
  classifyVideoError,
  isUpstreamTimeout,
  type VideoDetailsDTO,
} from "@/lib/mappers";
import { isPlausibleVideoId, parseLang, parseRegion } from "@/lib/validate";

export interface SponsorSegmentDTO {
  start: number;
  end: number;
  category: string;
}

export interface DislikesDTO {
  id: string;
  likes: number;
  dislikes: number;
  rating: number;
  viewCount: number;
  deleted: boolean;
  dateCreated: string;
}

export interface DeArrowThumbnailDTO {
  timestamp: number;
  url: string;
}

export interface DeArrowDTO {
  title: string | null;
  thumbnails: DeArrowThumbnailDTO[];
}

export interface CombinedDTO {
  video: VideoDetailsDTO | null;
  sponsors: SponsorSegmentDTO[];
  dislikes: DislikesDTO | null;
  dearrow: DeArrowDTO | null;
}

/** SponsorBlock categories requested (JSON-encoded into the query string). */
export const SPONSOR_CATEGORIES = [
  "sponsor",
  "intro",
  "outro",
  "interaction",
  "selfpromo",
  "music_offtopic",
] as const;

/** L0 cache keys: locale-independent (region/lang stay echo-only). */
export function sponsorsCacheKey(id: string): string {
  return `community:v1:sponsors:${id}`;
}

export function dislikesCacheKey(id: string): string {
  return `community:v1:dislikes:${id}`;
}

export function dearrowCacheKey(id: string): string {
  return `community:v1:dearrow:${id}`;
}

/** L0 fresh window for third-party crowd data; L1 CDN carries s-maxage. */
export const COMMUNITY_FRESH_MS = 30 * 60 * 1000;
/** Stale window backs serve-stale-on-error (mirrors the 21600s SWR). */
export const COMMUNITY_STALE_MS = 6 * 60 * 60 * 1000;

const STALE_WARNING = {
  code: "stale_served",
  message: "Upstream failed; serving a stale cached copy.",
};

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Maps a SponsorBlock skipSegments array to stable DTOs. Non-array payloads
 * yield []; malformed rows (no numeric segment pair, end <= start) are
 * dropped rather than failing the whole response.
 */
export function mapSponsorSegments(payload: unknown): SponsorSegmentDTO[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: SponsorSegmentDTO[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const seg = o.segment;
    if (!Array.isArray(seg) || seg.length < 2) {
      continue;
    }
    const start = toFiniteNumber(seg[0]);
    const end = toFiniteNumber(seg[1]);
    if (start === undefined || end === undefined || start < 0 || end <= start) {
      continue;
    }
    out.push({
      start,
      end,
      category: typeof o.category === "string" ? o.category : "sponsor",
    });
  }
  return out;
}

/**
 * Maps a ReturnYouTubeDislike votes payload 1:1. Returns null when the
 * payload is not an object or carries no usable like/dislike counts, so
 * callers serve data:null + a warning instead of a 404.
 */
export function mapDislikesResponse(
  payload: unknown,
  id: string,
): DislikesDTO | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const o = payload as Record<string, unknown>;
  const likes = toFiniteNumber(o.likes);
  const dislikes = toFiniteNumber(o.dislikes);
  if (likes === undefined || dislikes === undefined) {
    return null;
  }
  return {
    id,
    likes: Math.round(likes),
    dislikes: Math.round(dislikes),
    rating: toFiniteNumber(o.rating) ?? 0,
    viewCount: Math.round(toFiniteNumber(o.viewCount) ?? 0),
    deleted: o.deleted === true,
    dateCreated:
      typeof o.dateCreated === "string" && o.dateCreated !== ""
        ? o.dateCreated
        : "",
  };
}

/**
 * Maps a DeArrow branding payload: the top-voted non-original title wins
 * (null when only the original — or nothing — is served) and non-original
 * thumbnails resolve to dearrow-thumb URLs, highest votes first. Returns
 * null when no usable crowd entry exists, so callers serve data:null + a
 * warning instead of a 404.
 */
export function mapDeArrowResponse(
  payload: unknown,
  videoId: string,
): DeArrowDTO | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const o = payload as Record<string, unknown>;
  let title: string | null = null;
  if (Array.isArray(o.titles)) {
    let bestVotes = -Infinity;
    for (const t of o.titles) {
      if (typeof t !== "object" || t === null) {
        continue;
      }
      const e = t as Record<string, unknown>;
      if (e.original === true) {
        continue;
      }
      if (typeof e.title !== "string" || e.title.trim() === "") {
        continue;
      }
      const votes = toFiniteNumber(e.votes) ?? 0;
      if (votes > bestVotes) {
        bestVotes = votes;
        title = e.title;
      }
    }
  }
  const thumbnails: DeArrowThumbnailDTO[] = [];
  if (Array.isArray(o.thumbnails)) {
    const cands: Array<{ timestamp: number; votes: number }> = [];
    for (const t of o.thumbnails) {
      if (typeof t !== "object" || t === null) {
        continue;
      }
      const e = t as Record<string, unknown>;
      if (e.original === true) {
        continue;
      }
      const timestamp = toFiniteNumber(e.timestamp);
      if (timestamp === undefined || timestamp < 0) {
        continue;
      }
      cands.push({ timestamp, votes: toFiniteNumber(e.votes) ?? 0 });
    }
    cands.sort((a, b) => b.votes - a.votes);
    for (const c of cands) {
      thumbnails.push({
        timestamp: c.timestamp,
        url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoId)}&time=${encodeURIComponent(String(c.timestamp))}`,
      });
    }
  }
  if (title === null && thumbnails.length === 0) {
    return null;
  }
  return { title, thumbnails };
}

export type CommunitySource = "sponsors" | "dislikes" | "dearrow";

/**
 * Third-party failures are never definitive (crowd data may simply be
 * missing, and 404s are already mapped to []/null inside the fetchers):
 * timeouts/aborts -> 504 upstream_timeout; upstream 429s -> 429
 * rate_limited (Retry-After passed through, defaulting to 60s); everything
 * else -> 502 upstream_degraded. Never leaks stack traces.
 */
export function classifyCommunityError(
  source: CommunitySource,
  err: unknown,
): ClassifiedVideoError {
  const label =
    source === "sponsors"
      ? "Sponsor segments"
      : source === "dislikes"
        ? "Dislike stats"
        : "DeArrow branding";
  if (isUpstreamTimeout(err)) {
    return {
      code: "upstream_timeout",
      message: `${label} timed out upstream.`,
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  if (upstreamStatusOf(err) === 429) {
    return {
      code: "rate_limited",
      message: `${label} rate-limited upstream.`,
      hint: "Back off and retry after the Retry-After seconds.",
      status: 429,
      retryAfter: upstreamRetryAfterOf(err) ?? 60,
    };
  }
  return {
    code: "upstream_degraded",
    message: `${label} failed upstream.`,
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

/** Upstream HTTP status carried on thrown fetch errors (if any). */
function upstreamStatusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const status = (err as Record<string, unknown>).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** Retry-After seconds carried on thrown fetch errors (if any). */
function upstreamRetryAfterOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const retryAfter = (err as Record<string, unknown>).retryAfter;
    return typeof retryAfter === "number" &&
      Number.isFinite(retryAfter) &&
      retryAfter >= 0
      ? Math.round(retryAfter)
      : undefined;
  }
  return undefined;
}

function upstreamStatusError(
  label: string,
  status: number,
  retryAfter?: number,
): Error {
  return Object.assign(
    new Error(`${label} upstream responded with status ${status}`),
    {
      name: "UpstreamError",
      status,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  );
}

/** Reads an upstream Retry-After header (seconds) when valid. Missing,
 * empty, non-numeric, or negative values yield undefined so callers fall
 * back to the 60s default (note: Number("") is 0, so the raw value must be
 * checked for emptiness before parsing). */
function upstreamRetryAfter(res: Response): number | undefined {
  const raw = (res.headers.get("retry-after") ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Raw SponsorBlock fetch: 404 means "no segments" and maps to []. */
export async function fetchSponsorsUpstream(
  id: string,
): Promise<SponsorSegmentDTO[]> {
  const url =
    `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(id)}` +
    `&categories=${encodeURIComponent(JSON.stringify(SPONSOR_CATEGORIES))}&actionType=skip`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw upstreamStatusError(
      "SponsorBlock",
      res.status,
      upstreamRetryAfter(res),
    );
  }
  return mapSponsorSegments((await res.json()) as unknown);
}

/** Raw ReturnYouTubeDislike fetch: 404 means "no stats" and maps to null. */
export async function fetchDislikesUpstream(
  id: string,
): Promise<DislikesDTO | null> {
  const url = `https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(id)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw upstreamStatusError(
      "ReturnYouTubeDislike",
      res.status,
      upstreamRetryAfter(res),
    );
  }
  return mapDislikesResponse((await res.json()) as unknown, id);
}

/** Raw DeArrow fetch: 404 means "no branding" and maps to null. */
export async function fetchDeArrowUpstream(
  id: string,
): Promise<DeArrowDTO | null> {
  const url = `https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(id)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw upstreamStatusError("DeArrow", res.status, upstreamRetryAfter(res));
  }
  return mapDeArrowResponse((await res.json()) as unknown, id);
}

// Upstream seams: defaults hit the third-party APIs above (youtubei only via
// a lazy import in the combined video fetcher, so this module stays
// importable without the server-only singleton). Tests inject mocks here.
export interface SponsorsDeps {
  fetchSponsors: (id: string) => Promise<SponsorSegmentDTO[]>;
}

export interface DislikesDeps {
  fetchDislikes: (id: string) => Promise<DislikesDTO | null>;
}

export interface DeArrowDeps {
  fetchDeArrow: (id: string) => Promise<DeArrowDTO | null>;
}

export interface CombinedDeps {
  fetchVideo: (id: string) => Promise<VideoDetailsDTO>;
  fetchSponsors: (id: string) => Promise<SponsorSegmentDTO[]>;
  fetchDislikes: (id: string) => Promise<DislikesDTO | null>;
  fetchDeArrow: (id: string) => Promise<DeArrowDTO | null>;
}

const defaultSponsorsDeps: SponsorsDeps = {
  fetchSponsors: (id) => fetchSponsorsUpstream(id),
};

const defaultDislikesDeps: DislikesDeps = {
  fetchDislikes: (id) => fetchDislikesUpstream(id),
};

const defaultDeArrowDeps: DeArrowDeps = {
  fetchDeArrow: (id) => fetchDeArrowUpstream(id),
};

export const defaultCombinedDeps: CombinedDeps = {
  async fetchVideo(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    const innertube = await withTimeout(() => getInnertube(), 8000);
    const info = await withTimeout(() => innertube.getBasicInfo(id), 8000);
    const playability = (info as unknown as Record<string, unknown>)
      .playability_status as Record<string, unknown> | undefined;
    if (playability?.status === "LOGIN_REQUIRED") {
      throw Object.assign(new Error("LOGIN_REQUIRED: bot-guard"), {
        name: "InnertubeError",
      });
    }
    const { mapVideoDetails } = await import("@/lib/mappers");
    return mapVideoDetails(info);
  },
  fetchSponsors: (id) => fetchSponsorsUpstream(id),
  fetchDislikes: (id) => fetchDislikesUpstream(id),
  fetchDeArrow: (id) => fetchDeArrowUpstream(id),
};

function invalidVideoIdHint(example: string) {
  return {
    code: "invalid_video_id",
    message: "Invalid video id.",
    hint: `Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/${example}.`,
    status: 400,
  };
}

// NOTE on region/lang: echo-only request context (meta + CDN cache
// variance). Crowd sources are locale-independent, so cache keys are just
// the video id.
export async function handleSponsors(
  req: NextRequest,
  id: string,
  deps: SponsorsDeps = defaultSponsorsDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("sponsors"));
  }

  try {
    const result = await cached<SponsorSegmentDTO[]>(
      sponsorsCacheKey(id),
      COMMUNITY_FRESH_MS,
      () => deps.fetchSponsors(id),
      COMMUNITY_STALE_MS,
    );
    // Missing crowd data is data:[] (never 404): an unknown video simply has
    // no submitted segments.
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale ? [STALE_WARNING] : [],
      cacheControl: CACHE_CONTROL.sponsors,
    });
  } catch (err) {
    return errorResponse(requestId, classifyCommunityError("sponsors", err));
  }
}

export async function handleDislikes(
  req: NextRequest,
  id: string,
  deps: DislikesDeps = defaultDislikesDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("dislikes"));
  }

  try {
    const result = await cached<DislikesDTO | null>(
      dislikesCacheKey(id),
      COMMUNITY_FRESH_MS,
      () => deps.fetchDislikes(id),
      COMMUNITY_STALE_MS,
    );
    // Missing crowd data is data:null + a warning (never 404).
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings: [
        ...(result.stale ? [STALE_WARNING] : []),
        ...(result.value === null
          ? [
              {
                code: "dislikes_unavailable",
                message: "No dislike stats are available for this video.",
              },
            ]
          : []),
      ],
      cacheControl: CACHE_CONTROL.dislikes,
    });
  } catch (err) {
    return errorResponse(requestId, classifyCommunityError("dislikes", err));
  }
}

export async function handleDeArrow(
  req: NextRequest,
  id: string,
  deps: DeArrowDeps = defaultDeArrowDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("dearrow"));
  }

  try {
    const result = await cached<DeArrowDTO | null>(
      dearrowCacheKey(id),
      COMMUNITY_FRESH_MS,
      () => deps.fetchDeArrow(id),
      COMMUNITY_STALE_MS,
    );
    // Missing crowd data is data:null + a warning (never 404).
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings: [
        ...(result.stale ? [STALE_WARNING] : []),
        ...(result.value === null
          ? [
              {
                code: "dearrow_unavailable",
                message: "No crowd-sourced title or thumbnail for this video.",
              },
            ]
          : []),
      ],
      cacheControl: CACHE_CONTROL.dearrow,
    });
  } catch (err) {
    return errorResponse(requestId, classifyCommunityError("dearrow", err));
  }
}

function settled<T>(r: PromiseSettledResult<CachedResult<T>>): {
  value: T | null;
  hit: boolean;
  stale: boolean;
  failed: boolean;
  reason?: unknown;
} {
  if (r.status === "fulfilled") {
    return {
      value: r.value.value,
      hit: r.value.hit,
      stale: r.value.stale,
      failed: false,
    };
  }
  return {
    value: null,
    hit: false,
    stale: false,
    failed: true,
    reason: r.reason,
  };
}

/**
 * Overall fan-out budget for `combined` (ms). Deliberately just above the
 * single-fetch 8s timeout so that on a hung upstream the inner fetch
 * timeout fires first and the cached() stale path still wins (serving a
 * stale copy + warning) instead of losing the race to this outer budget.
 */
export const COMBINED_BUDGET_MS = 9500;

function combinedTimeoutError(): Error {
  const err = new Error(`Upstream timed out after ${COMBINED_BUDGET_MS}ms`);
  err.name = "TimeoutError";
  return err;
}

/**
 * Bounds one fan-out part by the shared overall budget: all four parts
 * start together, so the slowest straggler cannot push the response past
 * ~9.5s. A part that misses the budget rejects with a TimeoutError and is
 * treated as unavailable (null/[] + warning). A local race instead of
 * withTimeout() from lib/youtube — that module is server-only and must stay
 * out of this lib's executed paths (tests inject mocks and never touch it).
 */
function inBudget<T>(work: () => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(COMBINED_BUDGET_MS);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(combinedTimeoutError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Composed detail + all three crowd layers. Fans out over the same cached
 * helpers the single-source routes use (same L0 keys, so a warm singles
 * call warms combined and vice versa) under one shared ~9.5s budget — a part
 * that misses the budget is treated as unavailable. Every part degrades
 * independently: a failed crowd part becomes null/[] plus a warnings entry
 * and the response is still HTTP 200 — except a definitively missing video
 * (video_not_found), which returns 404 like GET /videos/:id.
 */
export async function handleCombined(
  req: NextRequest,
  id: string,
  deps: CombinedDeps = defaultCombinedDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("combined"));
  }

  const [videoRes, sponsorsRes, dislikesRes, dearrowRes] =
    await Promise.allSettled([
      inBudget(() =>
        cached<VideoDetailsDTO>(
          `video:v1:${id}`,
          5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
          () => deps.fetchVideo(id),
          60 * 60 * 1000, // stale window backs serve-stale-on-error.
          // Definitive not-found errors must NOT serve stale — only transient
          // failures (timeout/429/5xx) may.
          (err) => classifyVideoError(err).code !== "video_not_found",
        ),
      ),
      inBudget(() =>
        cached<SponsorSegmentDTO[]>(
          sponsorsCacheKey(id),
          COMMUNITY_FRESH_MS,
          () => deps.fetchSponsors(id),
          COMMUNITY_STALE_MS,
        ),
      ),
      inBudget(() =>
        cached<DislikesDTO | null>(
          dislikesCacheKey(id),
          COMMUNITY_FRESH_MS,
          () => deps.fetchDislikes(id),
          COMMUNITY_STALE_MS,
        ),
      ),
      inBudget(() =>
        cached<DeArrowDTO | null>(
          dearrowCacheKey(id),
          COMMUNITY_FRESH_MS,
          () => deps.fetchDeArrow(id),
          COMMUNITY_STALE_MS,
        ),
      ),
    ]);
  const video = settled(videoRes);
  const sponsors = settled(sponsorsRes);
  const dislikes = settled(dislikesRes);
  const dearrow = settled(dearrowRes);

  // A definitively missing video stays a 404 (parity with GET /videos/:id).
  // Stale copies never reach here for not-found: the video cache gate above
  // only serves stale on transient failures, and a served-stale video is
  // fulfilled, not failed.
  if (
    video.failed &&
    classifyVideoError(video.reason).code === "video_not_found"
  ) {
    return errorResponse(requestId, classifyVideoError(video.reason));
  }

  const warnings: Array<{ code: string; message: string }> = [];
  if (video.stale || sponsors.stale || dislikes.stale || dearrow.stale) {
    warnings.push(STALE_WARNING);
  }
  if (video.failed) {
    warnings.push({
      code: "video_unavailable",
      message: "Video detail failed upstream; combined response omits it.",
    });
  }
  if (sponsors.failed) {
    warnings.push({
      code: "sponsors_unavailable",
      message: "Sponsor segments unavailable; combined response omits them.",
    });
  }
  if (dislikes.failed || dislikes.value === null) {
    warnings.push({
      code: "dislikes_unavailable",
      message: "Dislike stats unavailable for this video.",
    });
  }
  if (dearrow.failed || dearrow.value === null) {
    warnings.push({
      code: "dearrow_unavailable",
      message: "Crowd-sourced title/thumbnail unavailable for this video.",
    });
  }

  const data: CombinedDTO = {
    video: video.value,
    sponsors: sponsors.value ?? [],
    dislikes: dislikes.value,
    dearrow: dearrow.value,
  };
  return successResponse(data, {
    requestId,
    region,
    lang,
    cached: video.hit || sponsors.hit || dislikes.hit || dearrow.hit,
    warnings,
    cacheControl: CACHE_CONTROL.combined,
  });
}
