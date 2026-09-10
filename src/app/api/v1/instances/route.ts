import type { NextRequest, NextResponse } from "next/server";
import { handleInstances } from "@/lib/utils";

export const runtime = "nodejs";

// Static in-code instance list (self + TUBELENS_PEER_INSTANCES peers) for
// failover-aware clients. No upstream call.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleInstances(req);
}
