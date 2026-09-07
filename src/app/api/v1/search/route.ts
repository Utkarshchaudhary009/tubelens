import type { NextRequest } from "next/server";
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
import { mapSearchItem, type SearchResultDTO } from "@/lib/mappers";
import {
  DEFAULT_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
  parseSearchParams,
  type SearchType,
} from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface SearchDeps {
  runSearch: (q: string, type: SearchType) => Promise<ContinuationSearch>;
  continueSearch: (search: ContinuationSearch) => Promise<ContinuationSearch>;
}

/**
 * Maps our public `type` filter to youtubei.js SearchFilters. youtubei's
 * SearchType enum has NO "all" key (unfiltered = ANY_TYPE, i.e. the ABSENCE
 * of a filter), so passing "all" through would rely on an undefined enum
 * lookup — omit the filter explicitly so default search never 502s.
 */
export function toUpstreamSearchFilters(type: SearchType): {
  type?: "video" | "channel" | "playlist";
} {
  return type === "all" ? {} : { type };
}

const defaultDeps: SearchDeps = {
  async runSearch(q, type) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    const innertube = await withTimeout(() => getInnertube(), 8000);
    const filters = toUpstreamSearchFilters(type);
    return (await withTimeout(
      () => innertube.search(q, filters),
      8000,
    )) as unknown as ContinuationSearch;
  },
  async continueSearch(search) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => search.getContinuation(),
      8000,
    )) as ContinuationSearch;
  },
};

export async function GET(req: NextRequest) {
  return handleSearch(req);
}

export async function handleSearch(
  req: NextRequest,
  deps: SearchDeps = defaultDeps,
) {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  // Cursor requests skip q/type validation entirely — only limit/region/lang
  // apply. Unknown/expired cursors yield [] + next: null, never an error.
  const cursor = params.get("cursor");
  if (cursor) {
    const limit = parseLimit(params.get("limit"));
    if (limit === null) {
      return errorResponse(requestId, {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50; defaults to 20.",
        status: 400,
      });
    }
    return serveContinuation(requestId, region, lang, cursor, limit, deps);
  }

  const parsed = parseSearchParams(params);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const { q, type, limit } = parsed.value;
  const cacheKey = `search:v1:${region}:${lang}:${type}:${limit}:${q.toLowerCase()}`;

  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state (serving a cursor advances its entry offset in the buffered
    // branch). An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: SearchResultDTO[];
      forkFrom: string | null;
    }>(cacheKey, 60_000, async () => {
      const search = await deps.runSearch(q, type);
      const items = search.results
        .slice(0, limit)
        .map(mapSearchItem)
        .filter((d): d is SearchResultDTO => d !== null);
      const forkFrom = storeContinuation(search, limit);
      return { items, forkFrom };
    });
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
      cacheControl: CACHE_CONTROL.search,
    });
  } catch {
    return errorResponse(requestId, {
      code: "upstream_degraded",
      message: "Search failed upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 502,
    });
  }
}

async function serveContinuation(
  requestId: string,
  region: string,
  lang: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps: SearchDeps = defaultDeps,
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
      cacheControl: CACHE_CONTROL.search,
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
      cacheControl: CACHE_CONTROL.search,
    });
  }
  // Buffer exhausted but upstream has more: fetch the next immutable page and
  // store it under a NEW cursor. This entry is left untouched, so fork-source
  // cursors (and repeat uses of this one) stay stable.
  try {
    const nextPage = await deps.continueSearch(entry.search);
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapSearchItem)
      .filter((d): d is SearchResultDTO => d !== null);
    const next = resolveNext(storeContinuation(nextPage, pageSize));
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.search,
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
      cacheControl: CACHE_CONTROL.search,
    });
  }
}
