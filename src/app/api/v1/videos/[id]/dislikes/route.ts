import type { NextRequest, NextResponse } from "next/server";
import {
  type DislikesDeps,
  fetchDislikesUpstream,
  handleDislikes,
} from "@/lib/community";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to ReturnYouTubeDislike
// (imported from lib/community, which never touches the server-only youtubei
// singleton). Tests inject mocks here and never touch the network.
const defaultDeps: DislikesDeps = {
  fetchDislikes: (id) => fetchDislikesUpstream(id),
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleDislikes(req, id, defaultDeps);
}
