import type { NextRequest, NextResponse } from "next/server";
import {
  type ContinuationSearch,
  FEED_SEED_QUERY,
  type FeedDeps,
  handleFeed,
} from "@/lib/feed";

export const runtime = "nodejs";

// Upstream seam: search(seed, { type: "video" }) narrowed to Shorts via
// applyRefinement("Shorts") when the chip is served (verified live: the
// refinement path returns a full ~20-item Video page, while the direct
// type:"shorts" filter returns only a handful of shelf-wrapped rows). When
// the chip is absent the base video results are served as-is — never an
// empty-by-design page. Lazily imports the server-only singleton so this
// module stays importable in tests, which inject mocks instead.
const defaultDeps: FeedDeps = {
  async fetchFirstPage() {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + search +
    // refinement), so the worst case stays ~8s instead of stacking
    // per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const base = await innertube.search(FEED_SEED_QUERY.shorts, {
        type: "video",
      });
      const refinements =
        (base as unknown as { refinement_filters?: unknown })
          .refinement_filters ?? [];
      if (Array.isArray(refinements) && refinements.includes("Shorts")) {
        return (await base.applyRefinement(
          "Shorts",
        )) as unknown as ContinuationSearch;
      }
      return base as unknown as ContinuationSearch;
    }, 8000);
  },
  async continueFeed(page) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => page.getContinuation(),
      8000,
    )) as ContinuationSearch;
  },
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleFeedShorts(req);
}

export function handleFeedShorts(
  req: NextRequest,
  deps: FeedDeps = defaultDeps,
): Promise<NextResponse> {
  return handleFeed(req, "shorts", deps);
}
