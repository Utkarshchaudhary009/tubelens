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
export type ChannelStreamsDeps = ChannelFeedDeps;

const defaultDeps: ChannelStreamsDeps = {
  resolveChannelId: defaultResolveChannelId,
  fetchFirstPage: (channelId) => defaultFetchFirstPage(channelId, "streams"),
  continueFeed: defaultContinueFeed,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannelStreams(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// the shelf is locale-independent and the cache key is just the resolved UC
// channel id + limit. Only live/upcoming/past nodes are returned — every
// item carries isLive/isUpcoming (plus scheduled start / viewer text where
// the node serves them); shorts-shaped nodes are dropped, and a channel
// with no live tab (has_live_streams=false) yields a terminal empty page,
// never a 404.
export async function handleChannelStreams(
  req: NextRequest,
  id: string,
  deps: ChannelStreamsDeps = defaultDeps,
): Promise<NextResponse> {
  return handleChannelFeed(req, id, "streams", deps);
}
