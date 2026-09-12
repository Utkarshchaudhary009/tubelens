import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  classifyTranscriptError,
  mapTranscriptInfo,
  type TranscriptSegmentDTO,
} from "@/lib/mappers";
import {
  type FetchLike,
  runTranscriptWaterfall,
} from "@/lib/transcript-providers";
import { isPlausibleVideoId, parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation chains the dictionary-driven
// TRANSCRIPT_PROVIDERS registry (Innertube fast path, then the
// youtube-cli waterfall) via runTranscriptWaterfall. Tests inject partial
// mocks here and never touch src/lib/youtube: omitting fetchFn disables the
// HTTP providers (no network in unit tests); production defaultDeps wires
// the global fetch.
export interface TranscriptDeps {
  fetchNative?: (
    id: string,
    signal: AbortSignal,
  ) => Promise<TranscriptSegmentDTO[]>;
  fetchFn?: FetchLike;
  env?: Record<string, string | undefined>;
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

async function defaultFetchNative(
  id: string,
  signal: AbortSignal,
): Promise<TranscriptSegmentDTO[]> {
  const { getInnertube } = await import("@/lib/youtube");
  // Honor the per-step abort: youtubei calls take no signal, so each await
  // races it — a hung fast path rejects with the signal instead of outliving
  // its step budget (the outer overall withTimeout(8000) still bounds the
  // whole waterfall; each registry entry clamps to the remaining budget).
  const innertube = await rejectOnAbort(getInnertube(), signal);
  // MUST use getInfo: getTranscript() throws on getBasicInfo payloads
  // ("Cannot get transcript from basic video info") because the engagement
  // panels only ride on the full watch-next response. Auto-captioned videos
  // work the same way — no track-kind filtering here.
  const info = await rejectOnAbort(innertube.getInfo(id), signal);
  const transcript = await rejectOnAbort(info.getTranscript(), signal);
  return mapTranscriptInfo(transcript);
}

/**
 * Rejects with the signal's reason (an AbortError, classifying 504 via
 * classifyTranscriptError) when the step budget fires before `task`
 * settles; otherwise passes the task's outcome through untouched.
 */
function rejectOnAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("Innertube fetch aborted (step budget)"), {
            name: "AbortError",
          }),
    );
  }
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("Innertube fetch aborted (step budget)"), {
              name: "AbortError",
            }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([task, gate]).finally(() => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

/**
 * Local overall-budget race with identical TimeoutError semantics to
 * lib/youtube's withTimeout (single copy lives there; this one exists so
 * unit tests that inject fetchNative never import the server-only
 * singleton — that import stalls ~20s under bun before throwing).
 */
async function localWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
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

/**
 * Default overall-budget wrapper. Lazily imports the server-only singleton
 * (keeps this module importable without it); outside a server context the
 * import throws and the local race applies the budget instead. The loader is
 * injectable so unit tests cover both branches without importing the
 * server-only singleton (that import stalls ~20s under bun before throwing).
 */
export type WithTimeoutLoader = () => Promise<{
  withTimeout: <T>(
    task: (signal: AbortSignal) => Promise<T>,
    ms?: number,
  ) => Promise<T>;
}>;

export async function defaultWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  load: WithTimeoutLoader = () => import("@/lib/youtube"),
): Promise<T> {
  let lib: Awaited<ReturnType<WithTimeoutLoader>>;
  try {
    // Scoped to the dynamic import ONLY: a waterfall rejection must
    // propagate as-is. Catching it here would re-run the whole waterfall
    // under the local budget (double upstream calls, double the 8s budget).
    lib = await load();
  } catch {
    return localWithTimeout(task, ms);
  }
  return lib.withTimeout(task, ms);
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
  fetchFn: fetch as unknown as FetchLike,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleTranscript(req, id);
}

// NOTE on region/lang: region is echo-only request context (meta + CDN cache
// variance). lang IS honored: it is passed down the provider chain (yttools
// ?lang=, track selection) and is part of the cache key
// (`transcript:v1:{id}:{lang}`). The full segment list is returned in one
// page (page.next is always null).
// Empty-vs-stale contract (shared with captions): stale wins. An empty fresh
// fetch never populates the cache (it throws, so `cached` falls back to any
// stale copy); a stale non-empty copy is served as 200 + `stale_served`
// regardless of the fresh outcome, and only a cold-miss empty is 404. A
// legacy stale-empty copy is still 404 — empties are never served as 200.
// Waterfall contract: the registry chain (innertube -> yttools ->
// youtube-transcript-ai -> kome -> supadata) runs under a SINGLE overall
// withTimeout(8000) around fast-path + chain combined (never stacked
// per-step budgets; each entry clamps to the remaining budget). First
// non-empty success wins; a definitive video_not_found short-circuits the
// chain (no provider can resurrect a private/deleted video, and it must NOT
// serve stale). Successful fallbacks are cached like fast-path results with
// the provider persisted in the cached value, and annotated with a
// `fallback_source` warning naming the provider (survives cache hits and
// in-flight joins); absent provider = Innertube fast path.
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
  // Single overall 8s fail-fast budget for the whole waterfall. When tests
  // inject fetchNative the local race applies it with no server-only import
  // (that import stalls ~20s under bun before throwing); the production path
  // (default fetchNative) reuses lib/youtube's wrapper via lazy import.
  const fetchNative = deps.fetchNative ?? defaultFetchNative;
  const withTimeout =
    deps.withTimeout ??
    (deps.fetchNative ? localWithTimeout : defaultWithTimeout);
  try {
    const result = await cached<CachedTranscript>(
      cacheKey,
      24 * 60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 86400s TTL.
      async () =>
        withTimeout(async () => {
          // Throw on empty so empty transcript lists never populate the
          // cache; classifyTranscriptError maps the marker to 404
          // transcript_unavailable, and `cached` falls back to any stale
          // copy (stale wins). The runner already throws on total failure,
          // so this guard only covers the impossible-empty case.
          const out = await runTranscriptWaterfall(id, lang, {
            fetchNative,
            fetchFn: deps.fetchFn,
            env: deps.env,
          });
          if (out.segments.length === 0) {
            throw new Error("transcript_unavailable: no transcript segments");
          }
          return out.provider
            ? { segments: out.segments, provider: out.provider }
            : { segments: out.segments };
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
