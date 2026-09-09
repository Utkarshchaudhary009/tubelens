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
export type ChannelShortsDeps = ChannelFeedDeps;

const defaultDeps: ChannelShortsDeps = {
  resolveChannelId: defaultResolveChannelId,
  fetchFirstPage: (channelId) => defaultFetchFirstPage(channelId, "shorts"),
  continueFeed: defaultContinueFeed,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannelShorts(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// the shelf is locale-independent and the cache key is just the resolved UC
// channel id + limit. Only shorts nodes are returned (ReelItem/
// ShortsLockupView/LockupView SHORT); long-form nodes are dropped, and a
// channel with no shorts tab (has_shorts=false) yields a terminal empty
// page, never a 404.
export async function handleChannelShorts(
  req: NextRequest,
  id: string,
  deps: ChannelShortsDeps = defaultDeps,
): Promise<NextResponse> {
  return handleChannelFeed(req, id, "shorts", deps);
}
