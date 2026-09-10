import type { NextRequest, NextResponse } from "next/server";
import { handleLyrics } from "@/lib/audio";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleLyrics(req, id);
}
