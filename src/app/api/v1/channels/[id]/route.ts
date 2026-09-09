import type { NextRequest, NextResponse } from "next/server";
import { type ChannelProfileDeps, handleChannelProfile } from "@/lib/channels";
import { defaultFetchProfile, defaultResolveChannelId } from "../_lib";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to youtubei.js (imported
// lazily so this module stays importable without the server-only singleton).
// Tests inject mocks here and never touch src/lib/youtube.
export type ChannelDeps = ChannelProfileDeps;

const defaultDeps: ChannelDeps = {
  resolveChannelId: defaultResolveChannelId,
  fetchProfile: defaultFetchProfile,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleChannel(req, id);
}

// NOTE on region/lang: echo-only request context (meta + CDN cache variance).
// The upstream session locale is fixed to en/US at singleton creation, so
// channel metadata is locale-independent and the cache key is just the
// resolved UC channel id. @handles resolve to that id before the fetch, so
// both address forms share one cache entry.
export async function handleChannel(
  req: NextRequest,
  id: string,
  deps: ChannelDeps = defaultDeps,
): Promise<NextResponse> {
  return handleChannelProfile(req, id, deps);
}
