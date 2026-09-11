import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  classifyTranscriptError,
  mapTranscriptInfo,
  type TranscriptSegmentDTO,
} from "@/lib/mappers";
import { isPlausibleVideoId, parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton)
// with yttools.co as fallback. Tests inject mocks here and never touch
// src/lib/youtube. The fallback runs only when deps.fetchFallback is
// present: defaultDeps wires the real yttools fetch, while fast-path-only
// mocks exercise Innertube alone (no network in unit tests).
export interface TranscriptFallback {
  segments: TranscriptSegmentDTO[];
  provider: string;
}

export interface TranscriptDeps {
  fetchTranscript: (id: string) => Promise<TranscriptSegmentDTO[]>;
  fetchFallback?: (id: string, lang: string) => Promise<TranscriptFallback>;
  /**
   * Single overall fail-fast budget wrapper (default: lib/youtube
   * withTimeout, lazily imported). Injectable so unit tests never touch the
   * server-only singleton.
   */
  withTimeout?: <T>(
    task: (signal: AbortSignal) => Promise<T>,
    ms: number,
  ) => Promise<T>;
}

/**
 * Default overall-budget wrapper. Lazily imports the server-only singleton
 * (keeps this module importable without it); outside a server context the
 * import throws and a local race with identical TimeoutError semantics
 * applies the budget instead.
 */
async function defaultWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  try {
    const { withTimeout } = await import("@/lib/youtube");
    return withTimeout(task, ms);
  } catch {
    const signal = AbortSignal.timeout(ms);
    let onAbort: (() => void) | undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const err = new Error(`Upstream timed out after ${ms}ms`);
        err.name = "TimeoutError";
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([task(signal), gate]);
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

/** Cached transcript payload: the provider rides in the cached value (not a
 *  closure), so cache hits and in-flight joins keep the fallback_source
 *  warning. Absent provider means the Innertube fast path served it. */
interface CachedTranscript {
  segments: TranscriptSegmentDTO[];
  provider?: string;
}

/**
 * Legacy entries (plain segment arrays, seeded before the provider field
 * existed) normalize to fast-path results with no provider. Corrupt entries
 * normalize to empty, which flows into the 404 path — never a 500.
 */
function normalizeCachedTranscript(value: unknown): CachedTranscript {
  if (Array.isArray(value)) {
    return { segments: value as TranscriptSegmentDTO[] };
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { segments?: unknown; provider?: unknown };
    if (Array.isArray(v.segments)) {
      const entry: CachedTranscript = {
        segments: v.segments as TranscriptSegmentDTO[],
      };
      if (typeof v.provider === "string" && v.provider !== "") {
        entry.provider = v.provider;
      }
      return entry;
    }
  }
  return { segments: [] };
}

const defaultDeps: TranscriptDeps = {
  async fetchTranscript(id) {
    const { getInnertube } = await import("@/lib/youtube");
    // Raw fetch with NO per-step timeout here: handleTranscript applies a
    // single overall withTimeout(8000) around fast-path + fallback combined,
    // so the worst case stays ~8s instead of stacking per-call timeouts.
    const innertube = await getInnertube();
    // MUST use getInfo: getTranscript() throws on getBasicInfo payloads
    // ("Cannot get transcript from basic video info") because the engagement
    // panels only ride on the full watch-next response. Auto-captioned videos
    // work the same way — no track-kind filtering here.
    const info = await innertube.getInfo(id);
    const transcript = await info.getTranscript();
    return mapTranscriptInfo(transcript);
  },
  async fetchFallback(id, lang) {
    const { fetchTranscriptFallback } = await import(
      "@/lib/transcript-providers"
    );
    return fetchTranscriptFallback(id, lang);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleTranscript(req, id);
}

// NOTE on region/lang: region is echo-only request context (meta + CDN cache
// variance). lang IS honored: it is passed to the yttools fallback
// (?lang=) and is part of the cache key. The full segment list is returned
// in one page (page.next is always null).
// Empty-vs-stale contract (shared with captions): stale wins. An empty fresh
// fetch never populates the cache (it throws, so `cached` falls back to any
// stale copy); a stale non-empty copy is served as 200 + `stale_served`
// regardless of the fresh outcome, and only a cold-miss empty is 404. A
// legacy stale-empty copy is still 404 — empties are never served as 200.
// Fallback contract: the Innertube fast path runs first; on failure (or an
// empty fast path) the yttools.co fallback is tried under a SINGLE overall
// withTimeout(8000) around fast-path + fallback combined (never stacked
// per-step budgets). A definitive video_not_found skips the fallback — no
// provider can resurrect a private/deleted video. Successful fallbacks are
// cached like fast-path results with the provider persisted in the cached
// value, and annotated with a `fallback_source` warning naming the provider
// (survives cache hits and in-flight joins).
export async function handleTranscript(
  req: NextRequest,
  id: string,
  deps: TranscriptDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, {
      code: "invalid_video_id",
      message: "Invalid video id.",
      hint: "Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/transcript.",
      status: 400,
    });
  }

  const cacheKey = `transcript:v1:${id}:${lang}`;
  // Single overall 8s fail-fast budget for fast-path + fallback combined
  // (injectable; defaults to the lib/youtube wrapper via lazy import).
  const withTimeout = deps.withTimeout ?? defaultWithTimeout;
  try {
    const result = await cached<CachedTranscript>(
      cacheKey,
      24 * 60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 86400s TTL.
      async () =>
        withTimeout(async () => {
          // Throw on empty so empty transcript lists never populate the cache;
          // classifyTranscriptError maps the marker to 404 transcript_unavailable,
          // and `cached` falls back to any stale copy (stale wins).
          let fastErr: unknown = null;
          try {
            const segments = await deps.fetchTranscript(id);
            if (segments.length > 0) {
              return { segments };
            }
            fastErr = new Error(
              "transcript_unavailable: no transcript segments",
            );
          } catch (err) {
            // Definitive not-found errors skip the fallback — no provider can
            // resurrect a private/deleted video (and must NOT serve stale).
            if (classifyTranscriptError(err).code === "video_not_found") {
              throw err;
            }
            fastErr = err;
          }
          if (deps.fetchFallback) {
            try {
              const fb = await deps.fetchFallback(id, lang);
              if (fb.segments.length > 0) {
                return { segments: fb.segments, provider: fb.provider };
              }
              // Empty fallback falls through to the fast-path error below —
              // an empty list is never served as 200.
            } catch (fbErr) {
              // A definitive fallback verdict (video_not_found — emitted only
              // on explicit deleted/private wording) overrides the fast-path
              // error: no provider can resurrect a deleted video, and it must
              // NOT serve stale. Anything else falls through to the fast-path
              // error below.
              if (classifyTranscriptError(fbErr).code === "video_not_found") {
                throw fbErr;
              }
            }
          }
          throw fastErr;
        }, 8000),
      24 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeouts, 429s, 5xx) and unavailable-transcript empties may.
      // Mirrors the videos/:id predicate via this route's classifier.
      (err) => classifyTranscriptError(err).code !== "video_not_found",
    );
    // The provider rides in the cached value (never a closure), so cache
    // hits and in-flight joins keep the fallback_source warning.
    const entry = normalizeCachedTranscript(result.value);
    // A stale-empty copy (seeded before this guard) is still a 404 — an
    // empty segment list is never served as 200.
    if (entry.segments.length === 0) {
      return errorResponse(requestId, {
        code: "transcript_unavailable",
        message: "No transcript is available for this video.",
        hint: "Captions may be disabled for this video; hide the transcript panel or try a video with manual or auto captions.",
        status: 404,
      });
    }
    const warnings: Array<{ code: string; message: string }> = [];
    if (result.stale) {
      warnings.push({
        code: "stale_served",
        message: "Upstream failed; serving a stale cached copy.",
      });
    }
    if (entry.provider) {
      warnings.push({
        code: "fallback_source",
        message: `Innertube transcript unavailable; served via ${entry.provider}.`,
      });
    }
    return successResponse(entry.segments, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings,
      cacheControl: CACHE_CONTROL.transcript,
    });
  } catch (err) {
    return errorResponse(requestId, classifyTranscriptError(err));
  }
}
