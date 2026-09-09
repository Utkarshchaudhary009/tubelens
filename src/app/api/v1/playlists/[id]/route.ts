import type { NextRequest, NextResponse } from "next/server";
import {
  handlePlaylistProfile,
  type PlaylistProfileDeps,
} from "@/lib/playlists";
import { defaultFetchPlaylist } from "../_lib";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type PlaylistDeps = PlaylistProfileDeps;

const defaultDeps: PlaylistDeps = {
  fetchPlaylist: defaultFetchPlaylist,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handlePlaylist(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// playlist metadata is locale-independent and the cache key is just the
// playlist id + limit. The response carries metadata plus the first items
// page; the forked cursor is scoped `playlist:{id}` so it also resolves
// under /playlists/:id/items for pages 2+.
export async function handlePlaylist(
  req: NextRequest,
  id: string,
  deps: PlaylistDeps = defaultDeps,
): Promise<NextResponse> {
  return handlePlaylistProfile(req, id, deps);
}
