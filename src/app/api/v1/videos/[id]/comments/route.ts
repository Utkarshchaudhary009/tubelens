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
import { type CommentDTO, classifyFeedError, mapComment } from "@/lib/mappers";
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
export interface CommentsDeps {
  fetchFirstPage: (id: string) => Promise<ContinuationSearch>;
  continueFeed: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

/**
 * Adapts a getComments Comments object to the generic continuation-page
 * shape: contents (CommentThread[]) are the items, has_continuation gates
 * paging, and getContinuation() yields the next immutable Comments page.
 */
function adaptComments(comments: {
  contents?: { [Symbol.iterator](): Iterator<unknown> } | null;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  const results = comments.contents ? [...comments.contents] : [];
  return {
    results,
    has_continuation: comments.has_continuation,
    getContinuation: async () =>
      adaptComments(
        (await comments.getContinuation()) as Parameters<
          typeof adaptComments
        >[0],
      ),
  };
}

const defaultDeps: CommentsDeps = {
  async fetchFirstPage(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + comments),
    // so the worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const comments = await innertube.getComments(id);
      return adaptComments(
        comments as unknown as Parameters<typeof adaptComments>[0],
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
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleComments(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// comment pages are locale-independent and the cache key is just video id +
// limit. Only top-level comments are returned; replies stay behind
// CommentThread continuations and are out of scope for Phase 2.
export async function handleComments(
  req: NextRequest,
  id: string,
  deps: CommentsDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, {
      code: "invalid_video_id",
      message: "Invalid video id.",
      hint: "Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/comments.",
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
    return serveContinuation(requestId, region, lang, id, cursor, limit, deps);
  }

  const cacheKey = `comments:v1:${id}:${limit}`;
  try {
    // L0 caches page-1 ITEMS plus the fork-source cursor string only. The
    // stored source is NEVER served directly — every caller (miss or hit)
    // gets a FRESH cursor via forkContinuation (own snapshot entry), so the
    // source stays pristine and concurrent users never share mutable entry
    // state. An evicted/expired fork source degrades to next: null.
    const result = await cached<{
      items: CommentDTO[];
      forkFrom: string | null;
    }>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 300s TTL.
      async () => {
        const page = await deps.fetchFirstPage(id);
        const items = page.results
          .slice(0, limit)
          .map(mapComment)
          .filter((d): d is CommentDTO => d !== null);
        const forkFrom = storeContinuation(page, limit, id);
        return { items, forkFrom };
      },
      30 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    // The source stays pristine: always fork, even on the miss that stored it.
    const next = forkContinuation(result.value.forkFrom, id);
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
        next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.comments,
    });
  } catch (err) {
    return errorResponse(requestId, classifyFeedError(err));
  }
}

async function serveContinuation(
  requestId: string,
  region: string,
  lang: string,
  videoId: string,
  cursor: string,
  pageSize: number = DEFAULT_LIMIT,
  deps: CommentsDeps = defaultDeps,
) {
  const entry = takeContinuation(cursor);
  // Best-effort: unknown/expired/exhausted cursor -> empty page, never error.
  // A cursor minted for another video is rejected the same way (the foreign
  // cursor is left untouched so it still works under its own video id).
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
  if (entry.scope !== undefined && entry.scope !== videoId) {
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
      .map(mapComment)
      .filter((d): d is CommentDTO => d !== null);
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
      .map(mapComment)
      .filter((d): d is CommentDTO => d !== null);
    const next = resolveNext(storeContinuation(nextPage, pageSize, videoId));
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
