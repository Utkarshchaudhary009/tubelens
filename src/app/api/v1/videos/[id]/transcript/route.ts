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
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface TranscriptDeps {
  fetchTranscript: (id: string) => Promise<TranscriptSegmentDTO[]>;
}

const defaultDeps: TranscriptDeps = {
  async fetchTranscript(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole fetch (session + info + transcript), so
    // the worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      // MUST use getInfo: getTranscript() throws on getBasicInfo payloads
      // ("Cannot get transcript from basic video info") because the engagement
      // panels only ride on the full watch-next response. Auto-captioned videos
      // work the same way — no track-kind filtering here.
      const info = await innertube.getInfo(id);
      const transcript = await info.getTranscript();
      return mapTranscriptInfo(transcript);
    }, 8000);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleTranscript(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so the
// transcript is locale-independent and the cache key is just the video id.
// The full segment list is returned in one page (page.next is always null).
// Empty-vs-stale contract (shared with captions): stale wins. An empty fresh
// fetch never populates the cache (it throws, so `cached` falls back to any
// stale copy); a stale non-empty copy is served as 200 + `stale_served`
// regardless of the fresh outcome, and only a cold-miss empty is 404. A
// legacy stale-empty copy is still 404 — empties are never served as 200.
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

  const cacheKey = `transcript:v1:${id}`;
  try {
    const result = await cached<TranscriptSegmentDTO[]>(
      cacheKey,
      24 * 60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 86400s TTL.
      async () => {
        // Throw on empty so empty transcript lists never populate the cache;
        // classifyTranscriptError maps the marker to 404 transcript_unavailable,
        // and `cached` falls back to any stale copy (stale wins).
        const segments = await deps.fetchTranscript(id);
        if (segments.length === 0) {
          throw new Error("transcript_unavailable: no transcript segments");
        }
        return segments;
      },
      24 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeouts, 429s, 5xx) and unavailable-transcript empties may.
      // Mirrors the videos/:id predicate via this route's classifier.
      (err) => classifyTranscriptError(err).code !== "video_not_found",
    );
    // A stale-empty copy (seeded before this guard) is still a 404 — an
    // empty segment list is never served as 200.
    if (result.value.length === 0) {
      return errorResponse(requestId, {
        code: "transcript_unavailable",
        message: "No transcript is available for this video.",
        hint: "Captions may be disabled for this video; hide the transcript panel or try a video with manual or auto captions.",
        status: 404,
      });
    }
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached copy.",
            },
          ]
        : [],
      cacheControl: CACHE_CONTROL.transcript,
    });
  } catch (err) {
    return errorResponse(requestId, classifyTranscriptError(err));
  }
}
