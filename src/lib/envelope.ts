import { type NextRequest, NextResponse } from "next/server";

// Shared success envelope + response headers.
// Every /api/v1 response follows plans/DX_PRINCIPLES.md:
//   { data, page: { next }, meta: { region, lang, cached, requestId }, warnings }

export interface Warning {
  code?: string;
  message: string;
}

/** X-Request-Id: echo the caller's value, otherwise mint one. Blank values
 * (empty or whitespace-only) are treated as missing. */
export function getRequestId(req: NextRequest): string {
  const echoed = req.headers.get("x-request-id");
  return echoed && echoed.trim() !== "" ? echoed : crypto.randomUUID();
}

/** Tracing + rate-limit stub headers attached to EVERY response. */
export function baseHeaders(requestId: string): Headers {
  const headers = new Headers();
  headers.set("X-Request-Id", requestId);
  // Phase 1: static stubs (no durable quota store yet — see Phase 10 /quota).
  headers.set("X-RateLimit-Limit", "100");
  headers.set("X-RateLimit-Remaining", "99");
  headers.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 60));
  return headers;
}

// Cache-Control values per plans/CACHING.md TTL table (L1 CDN layer).
export const CACHE_CONTROL = {
  /** health: short-lived liveness. */
  health: "public, s-maxage=60, stale-while-revalidate=60",
  /** health when degraded: revalidate fast so recovery is visible. */
  healthDegraded: "public, s-maxage=10, stale-while-revalidate=30",
  /** search: fast-moving. */
  search: "public, s-maxage=300, stale-while-revalidate=3600",
  /** related rail: fast-moving-ish (Phase 2). */
  related: "public, s-maxage=600, stale-while-revalidate=3600",
  /** search suggestions: autocomplete (Phase 3). */
  suggestions: "public, s-maxage=300, stale-while-revalidate=1800",
  /** hashtag feed: fast-moving band, same as related (Phase 3). */
  hashtag: "public, s-maxage=600, stale-while-revalidate=3600",
  /** channel uploads/shorts/streams feeds (Phase 4). */
  channelFeed: "public, s-maxage=600, stale-while-revalidate=3600",
  /** playlist items + channel playlists feeds (Phase 5). */
  playlistFeed: "public, s-maxage=600, stale-while-revalidate=3600",
  /** playlist metadata + first items page (Phase 5). */
  playlist: "public, s-maxage=3600, stale-while-revalidate=86400",
  /** music-native search (Phase 6). */
  musicSearch: "public, s-maxage=300, stale-while-revalidate=3600",
  /** music charts snapshot (Phase 6). */
  musicCharts: "public, s-maxage=600, stale-while-revalidate=3600",
  /** shorts discovery feed: fast-moving (Phase 7). */
  feedShorts: "public, s-maxage=600, stale-while-revalidate=3600",
  /** live discovery feed: fastest-moving vertical (Phase 7). */
  feedLive: "public, s-maxage=300, stale-while-revalidate=3600",
  /** gaming hub feed: fast-moving (Phase 7). */
  feedGaming: "public, s-maxage=600, stale-while-revalidate=3600",
  /** comments: fast-moving (Phase 2). */
  comments: "public, s-maxage=300, stale-while-revalidate=1800",
  /** captions: static-ish track list (Phase 2). */
  captions: "public, s-maxage=3600, stale-while-revalidate=86400",
  /** transcript: aggressive cache, never live-only (Phase 2). */
  transcript: "public, s-maxage=86400, stale-while-revalidate=86400",
  /** videos/:id + resolve: static-ish metadata. */
  staticish: "public, s-maxage=3600, stale-while-revalidate=86400",
  /** openapi.json: long-lived spec. */
  openapi: "public, s-maxage=86400, stale-while-revalidate=86400",
  /** typed errors: never cache. */
  noStore: "private, no-store",
} as const;

export interface SuccessOptions {
  requestId: string;
  /** Opaque cursor for the next page; null = end of list. */
  next?: string | null;
  region?: string;
  lang?: string;
  cached?: boolean;
  warnings?: Array<Warning | string>;
  cacheControl?: string;
  status?: number;
}

export function successResponse(
  data: unknown,
  opts: SuccessOptions,
): NextResponse {
  const warnings: Warning[] = (opts.warnings ?? []).map((w) =>
    typeof w === "string" ? { message: w } : w,
  );
  const body = {
    data,
    page: { next: opts.next ?? null },
    meta: {
      region: opts.region ?? "US",
      lang: opts.lang ?? "en",
      cached: opts.cached ?? false,
      requestId: opts.requestId,
    },
    warnings,
  };
  // Accepted: CDN s-maxage copies replay the origin requestId — the contract
  // requires presence of X-Request-Id/meta.requestId, not per-viewer uniqueness.
  const headers = baseHeaders(opts.requestId);
  headers.set("Content-Type", "application/json");
  if (opts.cacheControl) {
    headers.set("Cache-Control", opts.cacheControl);
  }
  return new NextResponse(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers,
  });
}
