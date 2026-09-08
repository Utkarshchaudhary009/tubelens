import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { parseSuggestionsParams } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface SuggestionsDeps {
  getSuggestions: (q: string) => Promise<string[]>;
}

const defaultDeps: SuggestionsDeps = {
  async getSuggestions(q) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole fetch (session + suggestions), so the
    // worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      return innertube.getSearchSuggestions(q);
    }, 8000);
  },
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleSuggestions(req);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// suggestions are locale-independent upstream; region/lang still vary the
// L0 key so cached entries never cross locales in meta.
export async function handleSuggestions(
  req: NextRequest,
  deps: SuggestionsDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;

  const parsed = parseSuggestionsParams(params);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const { q, limit, region, lang } = parsed.value;
  const cacheKey = `suggestions:v1:${region}:${lang}:${limit}:${q.toLowerCase()}`;

  try {
    // L0 caches the sliced page-1 suggestion list. Serve-stale-on-error:
    // an upstream failure with a stale copy serves it with meta.cached +
    // a stale_served warning; a cold-miss failure throws to the typed
    // 504/502 below.
    const result = await cached<string[]>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 300s TTL.
      async () => (await deps.getSuggestions(q)).slice(0, limit),
      30 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    return successResponse(result.value, {
      requestId,
      next: null,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving stale cached suggestions.",
            },
          ]
        : [],
      cacheControl: CACHE_CONTROL.suggestions,
    });
  } catch (err) {
    // Timeouts/aborts surface as 504 upstream_timeout per the openapi spec
    // (same signal as /search); everything else is 502.
    if (isUpstreamTimeout(err)) {
      return errorResponse(requestId, {
        code: "upstream_timeout",
        message: "Search suggestions timed out upstream.",
        hint: "Retry shortly; include X-Request-Id in bug reports.",
        status: 504,
      });
    }
    return errorResponse(requestId, {
      code: "upstream_degraded",
      message: "Search suggestions failed upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 502,
    });
  }
}

/** Timeout/abort signal matching /search's classifier. */
function isUpstreamTimeout(err: unknown): boolean {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /timeout|timed out|abort|TimeoutError|AbortError/i.test(raw);
}
