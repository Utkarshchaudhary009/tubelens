import type { NextRequest, NextResponse } from "next/server";
import { defaultAudioDeps, handleAudio } from "@/lib/audio";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleAudio(req, id, defaultAudioDeps);
}
