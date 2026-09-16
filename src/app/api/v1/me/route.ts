import type { NextRequest, NextResponse } from "next/server";
import {
  type AuthContext,
  requireAuth,
  unauthenticatedResponse,
} from "@/lib/auth";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { CACHE_CONTROL, successResponse } from "@/lib/envelope";
import { withRequestContext } from "@/lib/pipeline";
import type { Tier } from "@/lib/product";

export const runtime = "nodejs";

// GET /api/v1/me — Phase 02 protected proof endpoint. Requires a signed-in
// Clerk user and echoes the resolved identity as an envelope:
//   { data: { userId, tier }, page: { next: null }, meta, warnings }.
// - Authenticated personal data, so `private, no-store` (never CDN-cached).
// - Requires a *user* principal: `auth.type === "user"` AND a nonempty
//   `userId`. Future api-key principals (Phase 05) are authenticated but
//   must never read another principal's identity — even one carrying a
//   subject `userId` gets the same typed 401.
// - No upstream call, so the 8s fail-fast does not apply; no query/path
//   input, so no zod validation applies. Identity comes from the pipeline's
//   RequestContext (Clerk provider below), never from caller input.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withRequestContext(
    async (r, ctx) =>
      handleMe(ctx.requestId, ctx.auth, ctx.tier, r.headers.get("origin")),
    { auth: clerkAuthProvider },
    "me",
  )(req);
}

// Pure handler (no HTTP/pipeline): tests inject fake AuthContexts here and
// never need live Clerk keys; production reaches it via GET above. The
// trailing origin keeps purity (a plain string, never the Request) while
// letting direct-invoked denials carry the CORS grant.
export function handleMe(
  requestId: string,
  auth: AuthContext,
  tier: Tier,
  origin?: string | null,
): NextResponse {
  const denied = requireAuth({ auth, requestId, origin: origin ?? null });
  if (denied) {
    return denied;
  }
  // User-principal check (defense in depth): a non-user principal must never
  // read /me, even if it carries a subject userId (cf. Phase 05 api-keys).
  const userId = auth.type === "user" ? auth.userId : undefined;
  if (!userId) {
    return unauthenticatedResponse(requestId, origin);
  }
  return successResponse(
    { userId, tier },
    { requestId, cacheControl: CACHE_CONTROL.noStore, origin: origin ?? null },
  );
}
