import type { NextRequest, NextResponse } from "next/server";
import {
  type ContinuationSearch,
  FEED_SEED_QUERY,
  type FeedDeps,
  handleFeed,
} from "@/lib/feed";

export const runtime = "nodejs";

// Upstream seam: search(seed, { type: "video", features: ["live"] }) — the
// v18 Feature union carries "live" (verified live: ~19/20 rows arrive with
// is_live/is_upcoming plus "N watching" counts). Items map via
// mapChannelStream so every entry carries isLive/isUpcoming plus
// viewersText/scheduledStart where served. Lazily imports the server-only
// singleton so this module stays importable in tests, which inject mocks.
const defaultDeps: FeedDeps = {
  async fetchFirstPage() {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + search),
    // so the worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const search = await innertube.search(FEED_SEED_QUERY.live, {
        type: "video",
        features: ["live"],
      });
      return search as unknown as ContinuationSearch;
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
  return handleFeedLive(req);
}

export function handleFeedLive(
  req: NextRequest,
  deps: FeedDeps = defaultDeps,
): Promise<NextResponse> {
  return handleFeed(req, "live", deps);
}
