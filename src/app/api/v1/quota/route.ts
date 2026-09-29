import type { NextRequest, NextResponse } from "next/server";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { withRequestContext } from "@/lib/pipeline";
import { handleQuotaContext } from "@/lib/utils";

export const runtime = "nodejs";

// Monthly allowance balance (Phase 14): {allowance, used, remaining,
// reset, windowId, tier, policyVersion} for the CALLER's identity/window —
// identity and tier come from the pipeline's RequestContext (Clerk session
// or `ak_*` machine key; anonymous callers share the `anonymous` bucket),
// resolved through the same `quotaPrincipal` choke point the quota stage
// charges through, so the reported balance is the charged bucket.
// Read-only handler: `handleQuotaContext` itself never consumes, and the
// `quota` label is exempt from the pipeline quota stage — balance reads are
// free, so an exhausted caller can still read their balance and polling
// never taxes the allowance. Private, no-store.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withRequestContext(
    async (r, ctx) =>
      handleQuotaContext({
        requestId: ctx.requestId,
        auth: ctx.auth,
        tier: ctx.tier,
        rateLimitIdentity: ctx.rateLimitIdentity,
        origin: r.headers.get("origin"),
      }),
    { auth: clerkAuthProvider },
    "quota",
  )(req);
}
