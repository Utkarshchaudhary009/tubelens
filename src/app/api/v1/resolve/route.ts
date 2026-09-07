import type { NextRequest } from "next/server";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { classifyUrl, UnresolvableError } from "@/lib/resolve";
import { parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Pure URL classification — no upstream call. Handles watch + list combos
// (video wins, playlistId kept as context), music/nocookie hosts, Shorts,
// live, embeds, playlists, channels, @handles, and bare ids.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const url = params.get("url");
  if (!url || url.trim() === "") {
    return errorResponse(requestId, {
      code: "missing_url",
      message: "Query parameter url is required.",
      hint: "Add ?url= with a YouTube link, e.g. /api/v1/resolve?url=https://youtu.be/dQw4w9WgXcQ.",
      status: 400,
    });
  }

  try {
    const resolved = classifyUrl(url);
    return successResponse(resolved, {
      requestId,
      region,
      lang,
      cacheControl: CACHE_CONTROL.staticish,
    });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return errorResponse(requestId, {
        code: "unresolvable_url",
        message: err.message,
        hint: err.hint,
        status: 400,
      });
    }
    return errorResponse(requestId, {
      code: "upstream_degraded",
      message: "URL resolution failed.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 502,
    });
  }
}
