// Phase 7 (Explore verticals) shared feed handler.
// The three vertical feeds (shorts / live / gaming) are all search-backed
// and share one handler, exactly like the hashtag and channel-feed routes:
// L0-cached page-1 items + forked cursors, serve-stale-on-error, opaque
// cursors scoped per feed, no-store on any cursor-carrying page. Route files
// stay thin wrappers with their own deps seam (lazy youtubei import, single
// 8s first-page budget); tests inject mocks here and never touch
// src/lib/youtube.
//
// Upstream choices (verified live against youtubei.js v18, 2026-09-09):
// - shorts: search(query, { type: "video" }) + applyRefinement("Shorts").
//   The direct type:"shorts" filter returns only a handful of shelf-wrapped
//   rows (2-5); the refinement path returns a full 20-item Video page.
// - live: search(query, { type: "video", features: ["live"] }) — the v18
//   Feature union carries "live", and ~19/20 rows arrive with is_live /
//   is_upcoming plus "N watching" counts. Items map via mapChannelStream,
//   and rows carrying neither a live viewer count nor a scheduled start
//   are dropped (Phase 7 exit criterion: every item carries one or the
//   other) — the same no-leakage discipline as the Phase 4 channel mappers.
// - gaming: search(query, { type: "video" }). resolveURL(
//   "https://www.youtube.com/gaming") resolves to a topic channel
//   (UCOpNcN46UbXVtpKMrmU4Abg) whose getChannel serves NO video/live tabs
//   (has_videos/has_live_streams false, plus an AvatarStackView parser
//   error), so the browse-feed path is non-viable logged-out — search-backed
//   is the honest source, never fabricated or empty-by-design.

import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { type ChannelStreamDTO, mapChannelStream } from "@/lib/channels";
import {
  type ContinuationSearch,
  dropContinuation,
  forkContinuation,
  hasMoreResults,
  resolveNext,
  storeContinuation,
  takeContinuation,
} from "@/lib/continuations";

export type { ContinuationSearch } from "@/lib/continuations";

import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { mapSearchItem, type SearchResultDTO } from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

export type FeedKind = "shorts" | "live" | "gaming";

export type FeedItemDTO = SearchResultDTO | ChannelStreamDTO;

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily in route files so this module stays importable without the
// server-only singleton). Tests inject mocks here and never touch
// src/lib/youtube.
export interface FeedDeps {
  fetchFirstPage: () => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

/** Fixed documented seed query per feed (locale-independent). */
export const FEED_SEED_QUERY: Record<FeedKind, string> = {
  shorts: "shorts",
  live: "live",
  gaming: "gaming",
};

/** Cursor scope per feed: a cursor minted for one feed presented to another
 * is terminal ([] + next: null) and never yields foreign items. */
export function feedScope(kind: FeedKind): string {
  return `feed:${kind}`;
}

/** L0 cache key: locale-independent (upstream session is fixed to en/US),
 * so region/lang stay echo-only and share one entry. */
export function feedCacheKey(kind: FeedKind, limit: number): string {
  return `feed:v1:${kind}:${limit}`;
}

function feedCacheControl(kind: FeedKind): string {
  return kind === "live"
    ? CACHE_CONTROL.feedLive
    : kind === "shorts"
      ? CACHE_CONTROL.feedShorts
      : CACHE_CONTROL.feedGaming;
}

/** L0 fresh window per feed; L1 CDN carries the s-maxage TTL. */
function feedFreshMs(kind: FeedKind): number {
  return kind === "live" ? 5 * 60 * 1000 : 10 * 60 * 1000;
}

function feedMapper(kind: FeedKind): (node: unknown) => FeedItemDTO | null {
  return kind === "live" ? mapLiveItem : mapSearchItem;
}

/**
 * Live-only guard (Phase 7 exit criterion): the live-filtered search can
 * leak a generic/past Video row carrying neither a live viewer count nor a
 * scheduled start. Such rows map to null here and are dropped by callers —
 * the same no-leakage discipline as the Phase 4 channel mappers — so every
 * served feed/live item carries viewersText or scheduledStart.
 */
function mapLiveItem(node: unknown): FeedItemDTO | null {
  const dto = mapChannelStream(node);
  if (!dto) {
    return null;
  }
  return dto.viewersText !== undefined || dto.scheduledStart !== undefined
    ? dto
    : null;
}

export interface ClassifiedFeedError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

/**
 * Feed failures are never definitive (no per-id lookup): timeouts/aborts
 * -> 504 upstream_timeout; everything else -> 502 upstream_degraded. Never
 * leaks stack traces. All failures are retryable, so serve-stale-on-error
 * always applies when a stale copy exists.
 */
export function classifyExploreFeedError(
  kind: FeedKind,
  err: unknown,
): ClassifiedFeedError {
  const label =
    kind === "shorts" ? "Shorts" : kind === "live" ? "Live" : "Gaming";
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/timeout|timed out|abort|TimeoutError|AbortError/i.test(raw)) {
    return {
      code: "upstream_timeout",
      message: `${label} feed timed out upstream.`,
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  return {
    code: "upstream_degraded",
    message: `${label} feed failed upstream.`,
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// feeds are locale-independent and the cache key is just kind + limit.
export async function handleFeed(
  req: NextRequest,
  kind: FeedKind,
  deps: FeedDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return errorResponse(requestId, {
      code: "invalid_limit",
      message: "Invalid limit.",
      hint: "Use an integer between 1 and 50; defaults to 20.",
      status: 400,
    });
  }

  const scope = feedScope(kind);

  // Cursor requests skip re-fetching page 1 — only limit/region/lang apply.
  // Unknown/expired cursors yield [] + next: null, never an error.
  const cursor = params.get("cursor");
  if (cursor) {
    return serveFeedContinuation(
      requestId,
      region,
      lang,
      scope,
      cursor,
      limit,
      feedMapper(kind),
      deps,
    );
  }

  const cacheKey = feedCacheKey(kind, limit);
  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: FeedItemDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      feedFreshMs(kind),
      async () => {
        const page = await deps.fetchFirstPage();
        const mapItem = feedMapper(kind);
        const items = page.results
          .slice(0, limit)
          .map(mapItem)
          .filter((d): d is FeedItemDTO => d !== null);
        const forkFrom = storeContinuation(page, limit, scope);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, scope);
    // Cursors are process-local (see src/lib/continuations.ts): a response
    // carrying one must never sit in the shared CDN, or a replay on another
    // instance resolves it to [] + next: null. Only exhausted first pages
    // (next == null, no cursor involved) keep the public TTL.
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
        next !== null ? CACHE_CONTROL.noStore : feedCacheControl(kind),
    });
  } catch (err) {
    return errorResponse(requestId, classifyExploreFeedError(kind, err));
  }
}

async function serveFeedContinuation(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  mapItem: (node: unknown) => FeedItemDTO | null,
  deps: FeedDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // A cursor minted for another endpoint or feed is rejected the same way
  // (the foreign cursor is left untouched so it still works under its own
  // endpoint + feed). Every cursor response is private/no-store: cursors
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
      .filter((d): d is FeedItemDTO => d !== null);
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
      .filter((d): d is FeedItemDTO => d !== null);
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
