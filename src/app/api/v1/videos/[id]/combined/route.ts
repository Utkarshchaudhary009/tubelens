import type { NextRequest, NextResponse } from "next/server";
import { defaultCombinedDeps, handleCombined } from "@/lib/community";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleCombined(req, id, defaultCombinedDeps);
}
