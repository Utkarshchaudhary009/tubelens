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
  classifyHashtagError,
  mapSearchItem,
  type SearchResultDTO,
} from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  parseHashtagTag,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface HashtagDeps {
  fetchFirstPage: (tag: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

/**
 * Adapts a getHashtag HashtagFeed to the generic continuation-page shape:
 * feed.contents.contents (RichGrid of RichItem nodes, each with .content =
 * typically a Video node) are the items, has_continuation gates paging, and
 * getContinuation() yields the next immutable HashtagFeed page (re-adapted).
 */
export function adaptHashtag(feed: {
  contents?: {
    contents?: { [Symbol.iterator](): Iterator<unknown> } | null;
  } | null;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  const grid = feed.contents as
    | { contents?: { [Symbol.iterator](): Iterator<unknown> } | null }
    | null
    | undefined;
  const raw = grid?.contents ? [...grid.contents] : [];
  const results = raw.map((ri) =>
    typeof ri === "object" && ri !== null && "content" in ri
      ? ((ri as Record<string, unknown>).content ?? ri)
      : ri,
  );
  return {
    results,
    has_continuation: feed.has_continuation,
    getContinuation: async () =>
      adaptHashtag(
        (await feed.getContinuation()) as Parameters<typeof adaptHashtag>[0],
      ),
  };
}

const defaultDeps: HashtagDeps = {
  async fetchFirstPage(tag) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + feed), so
    // the worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const feed = await innertube.getHashtag(tag);
      return adaptHashtag(
        feed as unknown as Parameters<typeof adaptHashtag>[0],
      );
    }, 8000);
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
  ctx: { params: Promise<{ tag: string }> },
): Promise<NextResponse> {
  const { tag } = await ctx.params;
  return handleHashtag(req, tag);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// the feed is locale-independent and the cache key is just tag + limit.
export async function handleHashtag(
  req: NextRequest,
  tag: string,
  deps: HashtagDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  // Next.js delivers params already URL-decoded (%23lofi -> #lofi), so
  // validate directly: decoding again would throw on a literal % and 500
  // instead of returning the typed 400 below.
  const tagParsed = parseHashtagTag(tag ?? "");
  if (!tagParsed.ok) {
    return errorResponse(requestId, { ...tagParsed.error });
  }
  const normalized = tagParsed.value.toLowerCase();

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return errorResponse(requestId, {
      code: "invalid_limit",
      message: "Invalid limit.",
      hint: "Use an integer between 1 and 50; defaults to 20.",
      status: 400,
    });
  }

  // Cursor scope binds endpoint + tag: a hashtag cursor presented to another
  // endpoint (or another tag) is terminal ([] + next: null) and never yields
  // foreign items. Scopes live server-side in the continuation entry; the
  // opaque cursor itself reveals nothing.
  const scope = `hashtag:${normalized}`;

  // Cursor requests skip re-fetching page 1 — only limit/region/lang apply.
  // Unknown/expired cursors yield [] + next: null, never an error.
  const cursor = params.get("cursor");
  if (cursor) {
    return serveContinuation(
      requestId,
      region,
      lang,
      scope,
      cursor,
      limit,
      deps,
    );
  }

  const cacheKey = `hashtag:v1:${normalized}:${limit}`;
  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: SearchResultDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const page = await deps.fetchFirstPage(normalized);
        const items = page.results
          .slice(0, limit)
          .map(mapSearchItem)
          .filter((d): d is SearchResultDTO => d !== null);
        const forkFrom = storeContinuation(page, limit, scope);
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeout/429/5xx) may. Not-found propagates below.
      (err) => classifyHashtagError(err).code !== "hashtag_not_found",
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
        next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.hashtag,
    });
  } catch (err) {
    return errorResponse(requestId, classifyHashtagError(err));
  }
}

async function serveContinuation(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps: HashtagDeps = defaultDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // A cursor minted for another endpoint or tag is rejected the same way
  // (the foreign cursor is left untouched so it still works under its own
  // endpoint + tag). Every cursor response is private/no-store: cursors
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
      .map(mapSearchItem)
      .filter((d): d is SearchResultDTO => d !== null);
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
      .map(mapSearchItem)
      .filter((d): d is SearchResultDTO => d !== null);
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
