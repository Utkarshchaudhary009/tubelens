import type { NextRequest } from "next/server";
import { cached } from "@/lib/cache";
import {
  type ContinuationSearch,
  dropContinuation,
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
  continueSearch: (search: ContinuationSearch) => Promise<void>;
}

const defaultDeps: SearchDeps = {
  async runSearch(q, type) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    const innertube = await withTimeout(() => getInnertube(), 8000);
    return (await withTimeout(
      () => innertube.search(q, { type }),
      8000,
    )) as unknown as ContinuationSearch;
  },
  async continueSearch(search) {
    const { withTimeout } = await import("@/lib/youtube");
    await withTimeout(() => search.getContinuation() as Promise<unknown>, 8000);
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
    // L0 caches items only; the served cursor is re-validated via
    // resolveNext so an evicted/expired entry degrades to next: null
    // instead of dangling.
    const result = await cached<{
      items: SearchResultDTO[];
      next: string | null;
    }>(cacheKey, 60_000, async () => {
      const search = await deps.runSearch(q, type);
      const items = search.results
        .slice(0, limit)
        .map(mapSearchItem)
        .filter((d): d is SearchResultDTO => d !== null);
      const next = storeContinuation(search, limit);
      return { items, next };
    });
    return successResponse(result.value.items, {
      requestId,
      next: resolveNext(result.value.next),
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
  // Best-effort: unknown/expired cursor -> empty page, never an error.
  if (!entry || !entry.search.has_continuation) {
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
  try {
    await deps.continueSearch(entry.search);
    const items = entry.search.results
      .slice(entry.returned, entry.returned + pageSize)
      .map(mapSearchItem)
      .filter((d): d is SearchResultDTO => d !== null);
    entry.returned += pageSize;
    const next = entry.search.has_continuation ? cursor : null;
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
