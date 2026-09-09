import type { NextRequest, NextResponse } from "next/server";
import {
  type ContinuationSearch,
  FEED_SEED_QUERY,
  type FeedDeps,
  handleFeed,
} from "@/lib/feed";

export const runtime = "nodejs";

// Upstream seam: search(seed, { type: "video" }). The browse-feed alternative
// was verified non-viable logged-out (2026-09-09): resolveURL(
// "https://www.youtube.com/gaming") resolves to a topic channel
// (UCOpNcN46UbXVtpKMrmU4Abg) whose getChannel serves NO video/live tabs
// (has_videos/has_live_streams false, plus an AvatarStackView parser error),
// so a browse-backed feed would serve empty-by-design data. Search-backed is
// the honest source. Lazily imports the server-only singleton so this module
// stays importable in tests, which inject mocks instead.
const defaultDeps: FeedDeps = {
  async fetchFirstPage() {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    // Single 8s budget for the whole first-page fetch (session + search),
    // so the worst case stays ~8s instead of stacking per-call timeouts.
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const search = await innertube.search(FEED_SEED_QUERY.gaming, {
        type: "video",
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
  return handleFeedGaming(req);
}

export function handleFeedGaming(
  req: NextRequest,
  deps: FeedDeps = defaultDeps,
): Promise<NextResponse> {
  return handleFeed(req, "gaming", deps);
}
