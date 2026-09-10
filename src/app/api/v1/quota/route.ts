import type { NextRequest, NextResponse } from "next/server";
import { handleQuota } from "@/lib/utils";

export const runtime = "nodejs";

// In-memory stub quota counters (no durable store): {limit, remaining,
// reset} mirroring the X-RateLimit-* stub headers, plus per-window notes.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleQuota(req);
}
