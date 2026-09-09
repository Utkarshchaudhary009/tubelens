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
import {
  adaptMusicSearch,
  classifyMusicSearchError,
  type MusicItemDTO,
  type MusicSearchPage,
  type MusicSearchType,
  mapMusicItem,
  parseMusicSearchParams,
} from "@/lib/music";
import {
  DEFAULT_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface MusicSearchDeps {
  runSearch: (q: string, type: MusicSearchType) => Promise<MusicSearchPage>;
  continueSearch: (page: MusicSearchPage) => Promise<MusicSearchPage>;
}

const defaultDeps: MusicSearchDeps = {
  async runSearch(q, type) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + search).
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const filters = type === "all" ? undefined : { type };
      const search = filters
        ? await innertube.music.search(q, filters)
        : await innertube.music.search(q);
      return adaptMusicSearch(
        search as unknown as Parameters<typeof adaptMusicSearch>[0],
      );
    }, 8000);
  },
  async continueSearch(page) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => page.getContinuation(),
      8000,
    )) as MusicSearchPage;
  },
};

export async function GET(req: NextRequest) {
  return handleMusicSearch(req);
}

// Continuation-store scope for music-search cursors. Music search has no
// stable per-query scope on cursor requests (q is not re-validated there),
// so like /search it scopes by endpoint tag — a cursor minted by another
// endpoint presented here yields an empty page, never foreign items.
const MUSIC_SEARCH_SCOPE = "music-search";

export async function handleMusicSearch(
  req: NextRequest,
  deps: MusicSearchDeps = defaultDeps,
) {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;

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
    const region = parseRegion(params.get("region"));
    const lang = parseLang(params.get("lang"));
    return serveContinuation(requestId, region, lang, cursor, limit, deps);
  }

  const parsed = parseMusicSearchParams(params);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const { q, type, limit } = parsed.value;
  const regionValue = parseRegion(params.get("region"));
  const langValue = parseLang(params.get("lang"));
  const cacheKey = `music-search:v1:${regionValue}:${langValue}:${type}:${limit}:${q.toLowerCase()}`;

  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    // MusicSearchPage is structurally a ContinuationSearch (results +
    // has_continuation + immutable getContinuation), so it stores directly.
    const result = await cached<{
      items: MusicItemDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 300s TTL.
      async () => {
        const page = await deps.runSearch(q, type);
        const items = page.results
          .slice(0, limit)
          .map(mapMusicItem)
          .filter((d): d is MusicItemDTO => d !== null);
        const forkFrom = storeContinuation(
          page as unknown as ContinuationSearch,
          limit,
          MUSIC_SEARCH_SCOPE,
        );
        return { items, forkFrom };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, MUSIC_SEARCH_SCOPE);
    return successResponse(result.value.items, {
      requestId,
      next,
      region: regionValue,
      lang: langValue,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached page.",
            },
          ]
        : [],
      // Cursor pages are process-local (never CDN-cached): a response
      // carrying a cursor is private/no-store; only exhausted first pages
      // (next == null) keep the public TTL.
      cacheControl:
        next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.musicSearch,
    });
  } catch (err) {
    return errorResponse(requestId, classifyMusicSearchError(err));
  }
}

async function serveContinuation(
  requestId: string,
  region: string,
  lang: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps: MusicSearchDeps = defaultDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // Every cursor response is private/no-store: cursors are process-local, so
  // a CDN-cached cursor page would break paging on replay/cross-instance.
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
  // A cursor minted by another endpoint is rejected the same way (the foreign
  // cursor is left untouched so it still works under its own endpoint).
  if (entry.scope !== undefined && entry.scope !== MUSIC_SEARCH_SCOPE) {
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
      .map(mapMusicItem)
      .filter((d): d is MusicItemDTO => d !== null);
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
    const nextPage = await deps.continueSearch(
      entry.search as unknown as MusicSearchPage,
    );
    const items = nextPage.results
      .slice(0, pageSize)
      .map(mapMusicItem)
      .filter((d): d is MusicItemDTO => d !== null);
    const next = resolveNext(
      storeContinuation(
        nextPage as unknown as ContinuationSearch,
        pageSize,
        MUSIC_SEARCH_SCOPE,
      ),
    );
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch (err) {
    // Upstream page-fetch failure is a typed error (never a silent terminal
    // empty page — callers would mistake it for end-of-list). Only
    // unknown/expired cursors degrade to data:[] + next:null above.
    dropContinuation(cursor);
    return errorResponse(requestId, {
      ...classifyMusicSearchError(err),
      message: "Could not load the next page upstream.",
      hint: "Re-run the search to mint a fresh cursor; include X-Request-Id in bug reports.",
    });
  }
}
