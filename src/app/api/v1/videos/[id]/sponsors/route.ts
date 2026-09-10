import type { NextRequest, NextResponse } from "next/server";
import {
  fetchSponsorsUpstream,
  handleSponsors,
  type SponsorsDeps,
} from "@/lib/community";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to SponsorBlock (imported
// from lib/community, which never touches the server-only youtubei
// singleton). Tests inject mocks here and never touch the network.
const defaultDeps: SponsorsDeps = {
  fetchSponsors: (id) => fetchSponsorsUpstream(id),
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleSponsors(req, id, defaultDeps);
}
