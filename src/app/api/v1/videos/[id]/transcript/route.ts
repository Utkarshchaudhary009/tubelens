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
    const innertube = await withTimeout(() => getInnertube(), 8000);
    // MUST use getInfo: getTranscript() throws on getBasicInfo payloads
    // ("Cannot get transcript from basic video info") because the engagement
    // panels only ride on the full watch-next response. Auto-captioned videos
    // work the same way — no track-kind filtering here.
    const info = await withTimeout(() => innertube.getInfo(id), 8000);
    const transcript = await withTimeout(() => info.getTranscript(), 8000);
    return mapTranscriptInfo(transcript);
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
// Serve-stale-on-error: an upstream failure with a stale copy still returns
// 200 with meta.cached + warnings; only a cold-miss failure is a typed error.
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
      () => deps.fetchTranscript(id),
      24 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
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
