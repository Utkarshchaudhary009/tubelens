import type { NextRequest, NextResponse } from "next/server";
import { handlePlaylistFeed, type PlaylistFeedDeps } from "@/lib/playlists";
import { defaultContinueFeed, defaultFetchPlaylistFirstPage } from "../../_lib";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type PlaylistItemsDeps = PlaylistFeedDeps;

const defaultDeps: PlaylistItemsDeps = {
  fetchFirstPage: defaultFetchPlaylistFirstPage,
  continueFeed: defaultContinueFeed,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handlePlaylistItems(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// item order is locale-independent and the cache key is just the playlist id
// + limit. Pages 2+ walk the `playlist:{id}` cursor scope shared with the
// profile route's first-page cursor. Deleted/private videos degrade to typed
// placeholders ({ kind: deleted|private }), never drops or 500s.
export async function handlePlaylistItems(
  req: NextRequest,
  id: string,
  deps: PlaylistItemsDeps = defaultDeps,
): Promise<NextResponse> {
  return handlePlaylistFeed(req, id, deps);
}
