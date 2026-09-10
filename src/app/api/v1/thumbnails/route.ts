import type { NextRequest, NextResponse } from "next/server";
import { handleThumbnails } from "@/lib/utils";

export const runtime = "nodejs";

// Pure i.ytimg.com thumbnail resolver (?videoId=&quality=): no upstream
// call, and signed/proxied URLs are never involved.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleThumbnails(req);
}
