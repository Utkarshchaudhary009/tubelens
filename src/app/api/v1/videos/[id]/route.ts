import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  classifyVideoError,
  mapVideoDetails,
  type VideoDetailsDTO,
} from "@/lib/mappers";
import { isPlausibleVideoId, parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface VideoDeps {
  fetchVideo: (id: string) => Promise<VideoDetailsDTO>;
}

const defaultDeps: VideoDeps = {
  async fetchVideo(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    const innertube = await withTimeout(() => getInnertube(), 8000);
    const info = await withTimeout(() => innertube.getBasicInfo(id), 8000);
    const playability = (info as unknown as Record<string, unknown>)
      .playability_status as Record<string, unknown> | undefined;
    if (playability?.status === "LOGIN_REQUIRED") {
      throw Object.assign(new Error("LOGIN_REQUIRED: bot-guard"), {
        name: "InnertubeError",
      });
    }
    return mapVideoDetails(info);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleGetVideo(req, id);
}

// NOTE on region/lang: they are echo-only request context (meta + CDN cache
// variance). The upstream session locale is fixed to en/US at singleton
// creation — getBasicInfo takes no per-call locale — so video metadata is
// locale-independent and the cache key is intentionally just the video id.
export async function handleGetVideo(
  req: NextRequest,
  id: string,
  deps: VideoDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, {
      code: "invalid_video_id",
      message: "Invalid video id.",
      hint: "Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ.",
      status: 400,
    });
  }

  const cacheKey = `video:v1:${id}`;
  let staleServed = false;
  let cacheHit = false;

  try {
    const result = await cached<VideoDetailsDTO>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
      () => deps.fetchVideo(id),
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    staleServed = result.stale;
    cacheHit = result.hit;
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: cacheHit,
      warnings: staleServed
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached copy.",
            },
          ]
        : [],
      cacheControl: CACHE_CONTROL.staticish,
    });
  } catch (err) {
    const classified = classifyVideoError(err);
    return errorResponse(requestId, classified);
  }
}
