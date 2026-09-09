import type { NextRequest, NextResponse } from "next/server";
import { type ChannelFeedDeps, handleChannelFeed } from "@/lib/channels";
import {
  defaultContinueFeed,
  defaultFetchFirstPage,
  defaultResolveChannelId,
} from "../../_lib";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type ChannelVideosDeps = ChannelFeedDeps;

const defaultDeps: ChannelVideosDeps = {
  resolveChannelId: defaultResolveChannelId,
  fetchFirstPage: (channelId) => defaultFetchFirstPage(channelId, "videos"),
  continueFeed: defaultContinueFeed,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannelVideos(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// uploads are locale-independent and the cache key is just the resolved UC
// channel id + limit. Only long-form nodes are returned (Video/GridVideo/
// CompactVideo/LockupView VIDEO); shorts-shaped nodes are dropped, never
// leaked into this feed.
export async function handleChannelVideos(
  req: NextRequest,
  id: string,
  deps: ChannelVideosDeps = defaultDeps,
): Promise<NextResponse> {
  return handleChannelFeed(req, id, "videos", deps);
}
