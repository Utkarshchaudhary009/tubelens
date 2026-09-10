import type { NextRequest, NextResponse } from "next/server";
import { handleMix } from "@/lib/utils";

export const runtime = "nodejs";

// Seed -> mix id lookup is a pure resolver (no upstream call): RD mix ids
// pass through, any other mix/playlist-ish id maps to RD+seed. Read items
// via GET /api/v1/playlists/{mixId}.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleMix(req, id);
}
