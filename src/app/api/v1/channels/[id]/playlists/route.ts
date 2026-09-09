import type { NextRequest, NextResponse } from "next/server";
import {
  defaultContinueFeed,
  defaultResolveChannelId,
} from "@/app/api/v1/channels/_lib";
import { defaultFetchChannelPlaylistsFirstPage } from "@/app/api/v1/playlists/_lib";
import {
  type ChannelPlaylistsDeps,
  handleChannelPlaylists as handleChannelPlaylistsLib,
} from "@/lib/playlists";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type ChannelPlaylistsRouteDeps = ChannelPlaylistsDeps;

const defaultDeps: ChannelPlaylistsRouteDeps = {
  resolveChannelId: defaultResolveChannelId,
  fetchFirstPage: defaultFetchChannelPlaylistsFirstPage,
  continueFeed: defaultContinueFeed,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannelPlaylists(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// channel playlists are locale-independent. The address is resolved to its
// canonical UC id BEFORE caching, so @handle and UC form share one scope
// (`channel:playlists:{id}`), one cache entry, and interoperable cursors. A
// channel with no playlists shelf yields data:[] + next:null, never 404.
export async function handleChannelPlaylists(
  req: NextRequest,
  id: string,
  deps: ChannelPlaylistsRouteDeps = defaultDeps,
): Promise<NextResponse> {
  return handleChannelPlaylistsLib(req, id, deps);
}
