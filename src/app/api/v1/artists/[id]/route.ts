import type { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  type ArtistProfileDTO,
  classifyArtistError,
  mapArtistProfile,
  parseArtistId,
} from "@/lib/music";
import { parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface ArtistDeps {
  /** UC artist id -> raw music.getArtist payload for mapArtistProfile. */
  fetchArtist: (artistId: string) => Promise<unknown>;
}

const defaultDeps: ArtistDeps = {
  async fetchArtist(artistId) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole profile fetch (session + artist).
    return withTimeout(async () => {
      const innertube = await getInnertube();
      return (await innertube.music.getArtist(artistId)) as unknown;
    }, 8000);
  },
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleArtist(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// artist metadata is locale-independent and the cache key is just the UC id.
export async function handleArtist(
  req: NextRequest,
  id: string,
  deps: ArtistDeps = defaultDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  // Non-UC ids are a 400 invalid_artist_id (getArtist requires the UC form) —
  // never a 502.
  const parsed = parseArtistId(id ?? "");
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const artistId = parsed.value;
  const cacheKey = `artist:v1:${artistId}`;

  try {
    const result = await cached<ArtistProfileDTO>(
      cacheKey,
      5 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
      async () => {
        const raw = await deps.fetchArtist(artistId);
        const dto = mapArtistProfile(raw, artistId);
        if (!dto) {
          throw new Error(`artist_not_found: ${artistId}`);
        }
        return dto;
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeout/429/5xx) may. Not-found propagates below.
      (err) => classifyArtistError(err).code !== "artist_not_found",
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
      cacheControl: CACHE_CONTROL.staticish,
    });
  } catch (err) {
    return errorResponse(requestId, classifyArtistError(err));
  }
}
