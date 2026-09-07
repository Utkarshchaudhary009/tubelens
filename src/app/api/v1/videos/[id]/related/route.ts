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
import {
  classifyFeedError,
  mapRelatedItem,
  type RelatedItemDTO,
} from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  isPlausibleVideoId,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface RelatedDeps {
  fetchFirstPage: (id: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

/**
 * Adapts a getInfo VideoInfo to the generic continuation-page shape:
 * watch_next_feed nodes are the items, wn_has_continuation gates paging, and
 * getWatchNextContinuation() yields the next immutable VideoInfo page.
 */
function adaptWatchNext(info: {
  watch_next_feed?: { [Symbol.iterator](): Iterator<unknown> } | null;
  wn_has_continuation: boolean;
  getWatchNextContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  const results = info.watch_next_feed ? [...info.watch_next_feed] : [];
  return {
    results,
    has_continuation: info.wn_has_continuation,
    getContinuation: async () =>
      adaptWatchNext(
        (await info.getWatchNextContinuation()) as Parameters<
          typeof adaptWatchNext
        >[0],
      ),
  };
}

const defaultDeps: RelatedDeps = {
  async fetchFirstPage(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    const innertube = await withTimeout(() => getInnertube(), 8000);
    const info = await withTimeout(() => innertube.getInfo(id), 8000);
    return adaptWatchNext(
      info as unknown as Parameters<typeof adaptWatchNext>[0],
    );
  },
  async continueFeed(page) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => page.getContinuation(),
      8000,
    )) as ContinuationSearch;
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleRelated(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so the
// rail is locale-independent and the cache key is just video id + limit.
export async function handleRelated(
  req: NextRequest,
  id: string,
  deps: RelatedDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, {
      code: "invalid_video_id",
      message: "Invalid video id.",
      hint: "Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/related.",
      status: 400,
    });
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

  // Cursor requests skip re-fetching page 1 — only limit/region/lang apply.
  // Unknown/expired cursors yield [] + next: null, never an error.
  const cursor = params.get("cursor");
  if (cursor) {
    return serveContinuation(requestId, region, lang, cursor, limit, deps);
  }

  const cacheKey = `related:v1:${id}:${limit}`;
  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: RelatedItemDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const page = await deps.fetchFirstPage(id);
        const items = page.results
          .slice(0, limit)
          .map(mapRelatedItem)
          .filter((d): d is RelatedItemDTO => d !== null);
        const forkFrom = storeContinuation(page, limit);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom);
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
      cacheControl: CACHE_CONTROL.related,
    });
  } catch (err) {
    return errorResponse(requestId, classifyFeedError(err));
  }
}

async function serveContinuation(
  requestId: string,
  region: string,
  lang: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps: RelatedDeps = defaultDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  if (!entry || !hasMoreResults(entry)) {
    if (entry) {
      dropContinuation(cursor);
    }
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.related,
    });
  }
  // Buffered items remain on this page object: serve from this entry's own
  // offset (per-cursor state — forks own their entry) and keep the cursor.
  if (entry.returned < entry.search.results.length) {
    const items = entry.search.results
      .slice(entry.returned, entry.returned + pageSize)
      .map(mapRelatedItem)
      .filter((d): d is RelatedItemDTO => d !== null);
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
      cacheControl: CACHE_CONTROL.related,
    });
  }
  // Buffer exhausted but upstream has more: fetch the next immutable page and
  // store it under a NEW cursor. This entry is left untouched, so fork-source
  // cursors (and repeat uses of this one) stay stable.
  try {
    const nextPage = await deps.continueFeed(entry.search);
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapRelatedItem)
      .filter((d): d is RelatedItemDTO => d !== null);
    const next = resolveNext(storeContinuation(nextPage, pageSize));
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.related,
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
      cacheControl: CACHE_CONTROL.related,
    });
  }
}
