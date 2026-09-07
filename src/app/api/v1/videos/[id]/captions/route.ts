import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  type CaptionTrackDTO,
  classifyCaptionsError,
  mapCaptionList,
} from "@/lib/mappers";
import { isPlausibleVideoId, parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface CaptionsDeps {
  fetchCaptions: (id: string) => Promise<CaptionTrackDTO[]>;
}

const defaultDeps: CaptionsDeps = {
  async fetchCaptions(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole fetch (session + info), so the worst
    // case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      // getInfo (not getBasicInfo): caption tracks ride on the player response.
      const info = await innertube.getInfo(id);
      return mapCaptionList(
        (info as unknown as Record<string, unknown>).captions,
      );
    }, 8000);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleCaptions(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so the
// track list is locale-independent and the cache key is just the video id.
// Serve-stale-on-error: an upstream failure with a stale copy still returns
// 200 with meta.cached + warnings; only a cold-miss failure is a typed error.
export async function handleCaptions(
  req: NextRequest,
  id: string,
  deps: CaptionsDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, {
      code: "invalid_video_id",
      message: "Invalid video id.",
      hint: "Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/captions.",
      status: 400,
    });
  }

  const cacheKey = `captions:v1:${id}`;
  try {
    const result = await cached<CaptionTrackDTO[]>(
      cacheKey,
      60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
      async () => {
        // Throw on empty so disabled-caption lists never populate the cache;
        // classifyCaptionsError maps the marker to 404 captions_disabled.
        const tracks = await deps.fetchCaptions(id);
        if (tracks.length === 0) {
          throw new Error("captions_disabled: no caption tracks");
        }
        return tracks;
      },
      24 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    // A stale-empty copy (seeded before this guard) is still a 404 — an
    // empty track list is never served as 200.
    if (result.value.length === 0) {
      return errorResponse(requestId, {
        code: "captions_disabled",
        message: "No caption tracks are available for this video.",
        hint: "This video has captions disabled; hide the captions UI or fall back to the description.",
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
      cacheControl: CACHE_CONTROL.captions,
    });
  } catch (err) {
    return errorResponse(requestId, classifyCaptionsError(err));
  }
}
