import type { NextRequest, NextResponse } from "next/server";
import {
  type DeArrowDeps,
  fetchDeArrowUpstream,
  handleDeArrow,
} from "@/lib/community";

export const runtime = "nodejs";

// Upstream seam: the default implementation talks to the DeArrow branding
// API (imported from lib/community, which never touches the server-only
// youtubei singleton). Tests inject mocks here and never touch the network.
const defaultDeps: DeArrowDeps = {
  fetchDeArrow: (id) => fetchDeArrowUpstream(id),
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleDeArrow(req, id, defaultDeps);
}
