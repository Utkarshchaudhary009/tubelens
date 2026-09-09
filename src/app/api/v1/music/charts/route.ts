import type { NextRequest } from "next/server";
import { cached } from "@/lib/cache";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  type ChartSectionDTO,
  classifyChartsError,
  extractChartShelves,
  mapChartSections,
  parseMusicChartsParams,
} from "@/lib/music";
import { parseLang, parseRegion } from "@/lib/validate";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export interface MusicChartsDeps {
  /** Raw parsed charts browse response (shelf navigation happens in-mapper). */
  fetchCharts: () => Promise<unknown>;
}

// Charts browseId + params (verified live 2026-09-09): the Charts entry in
// getExplore() carries browseId FEmusic_charts with these exact params; a
// bare browse without params returns no sections.
export const CHARTS_BROWSE_ID = "FEmusic_charts";
export const CHARTS_PARAMS = "sgYPRkVtdXNpY19leHBsb3Jl";

const defaultDeps: MusicChartsDeps = {
  async fetchCharts() {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole snapshot fetch (session + browse).
    return withTimeout(async () => {
      const innertube = await getInnertube();
      return (await innertube.actions.execute("/browse", {
        browseId: CHARTS_BROWSE_ID,
        params: CHARTS_PARAMS,
        client: "YTMUSIC",
        parse: true,
      })) as unknown;
    }, 8000);
  },
};

export async function GET(req: NextRequest) {
  return handleMusicCharts(req);
}

// NOTE on region/lang/country: echo-only request context (meta + CDN cache
// variance). The upstream session locale is fixed to en/US at singleton
// creation and the charts snapshot has no per-country browse — so a non-US
// country is served the default snapshot with a country_fallback warning
// rather than fabricated per-country data. The cache key still carries the
// country so snapshots never mix across values.
export async function handleMusicCharts(
  req: NextRequest,
  deps: MusicChartsDeps = defaultDeps,
) {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  const parsed = parseMusicChartsParams(params);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const { country, limit } = parsed.value;
  const cacheKey = `music-charts:v1:${country}:${limit}`;

  try {
    // Single snapshot — no pagination (next is always null). Empty upstream
    // (no shelves/sections) is served as data:[] + next:null, never a 404.
    const result = await cached<{
      sections: ChartSectionDTO[];
    }>(
      cacheKey,
      10 * 60 * 1000, // L0 fresh window; L1 CDN carries the 600s TTL.
      async () => {
        const raw = await deps.fetchCharts();
        const sections = mapChartSections(extractChartShelves(raw), limit);
        return { sections };
      },
      60 * 60 * 1000, // stale window backs serve-stale-on-error.
    );
    const warnings: Array<{ code: string; message: string }> = [];
    if (result.stale) {
      warnings.push({
        code: "stale_served",
        message: "Upstream failed; serving a stale cached snapshot.",
      });
    }
    if (country !== "US") {
      warnings.push({
        code: "country_fallback",
        message:
          "Country-specific charts are unavailable on the shared session; serving the default charts snapshot.",
      });
    }
    return successResponse(
      { country, sections: result.value.sections },
      {
        requestId,
        next: null,
        region,
        lang,
        cached: result.hit,
        warnings,
        cacheControl: CACHE_CONTROL.musicCharts,
      },
    );
  } catch (err) {
    return errorResponse(requestId, classifyChartsError(err));
  }
}
