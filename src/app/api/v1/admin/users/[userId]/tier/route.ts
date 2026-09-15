import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import {
  type AuthContext,
  forbiddenResponse,
  mapAdminBodyError,
  normalizeRole,
  requireAdmin,
  USER_ID_PATTERN,
  unauthenticatedResponse,
} from "@/lib/auth";
import {
  type ClerkAdminClient,
  clerkErrorResponse,
  getClerkAdminClient,
} from "@/lib/clerk-admin";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { CACHE_CONTROL, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { withRequestContext } from "@/lib/pipeline";
import { normalizeTier } from "@/lib/product";

export const runtime = "nodejs";

// PATCH /api/v1/admin/users/:userId/tier — admin-only tier change.
// `.strict()` denies smuggled keys (a caller cannot slip `role`/privilege
// fields past this body). Self-change policy: an admin MAY change their own
// tier — tier is an entitlement label, not privilege, and the actor is
// already `admin`. Only the role route carries the self-demotion guard
// (actor === target && role !== "admin" → 403), per PLAN Phase 04.
export const tierBodySchema = z
  .object({
    tier: z.enum(["free", "plus", "pro", "enterprise"]),
    // Trimmed so ""/whitespace-only reasons become droppable audit noise
    // (the handler passes `reason || undefined`); max applies post-trim.
    reason: z.string().trim().max(280).optional(),
  })
  .strict();

export interface TierPatchDeps {
  clerk?: ClerkAdminClient;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const { userId } = await ctx.params;
  return withRequestContext(
    async (r, c) => {
      let rawBody: unknown;
      try {
        rawBody = await r.json();
      } catch {
        return errorResponse(c.requestId, {
          code: "invalid_body",
          message: "Request body must be valid JSON.",
          hint: 'Send a JSON body like { "tier": "pro" } with Content-Type: application/json.',
          status: 400,
        });
      }
      return handleTierPatch(c.requestId, c.auth, userId, rawBody);
    },
    { auth: clerkAuthProvider },
    "admin.users.tier",
  )(req);
}

// Pure handler (no HTTP/pipeline): tests inject fake AuthContexts + a mocked
// Clerk seam here and never need live keys; production reaches it via PATCH.
export async function handleTierPatch(
  requestId: string,
  auth: AuthContext,
  targetUserId: string,
  rawBody: unknown,
  deps: TierPatchDeps = {},
): Promise<NextResponse> {
  const caller = requireAdmin(auth);
  if (!caller.ok) {
    return caller.code === "unauthenticated"
      ? unauthenticatedResponse(requestId)
      : forbiddenResponse(requestId);
  }
  if (!USER_ID_PATTERN.test(targetUserId)) {
    return errorResponse(requestId, {
      code: "invalid_user_id",
      message: "Invalid user id.",
      hint: "Use a Clerk user id like user_abc123; it must match /^user_[A-Za-z0-9]+$/.",
      status: 400,
    });
  }
  const parsed = tierBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const mapped = mapAdminBodyError("tier", parsed.error.issues);
    return errorResponse(requestId, { ...mapped, status: 400 });
  }
  const { tier: newTier, reason } = parsed.data;

  // Authoritative write path: re-fetch Clerk metadata (claims lag ~60s) and
  // record old tier/role from it — never from the session claim. Each Clerk
  // call mints its own 8s budget: sharing one signal would let the read eat
  // into the write's fail-fast window.
  const clerk = deps.clerk ?? getClerkAdminClient();
  let oldTier: ReturnType<typeof normalizeTier>;
  let oldRole: ReturnType<typeof normalizeRole>;
  try {
    const record = await clerk.getUser(targetUserId, {
      signal: AbortSignal.timeout(8000),
    });
    oldTier = normalizeTier(record.publicMetadata?.tier);
    oldRole = normalizeRole(record.publicMetadata?.role);
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }
  try {
    // Dedicated metadata method (deep-merge): write BOTH keys so the
    // untouched role survives the tier change.
    await clerk.updateUserMetadata(
      targetUserId,
      { publicMetadata: { tier: newTier, role: oldRole } },
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }

  recordAuditEvent({
    action: "user.tier.changed",
    actor: caller.userId,
    target: targetUserId,
    targetUserId,
    oldTier,
    newTier,
    requestId,
    ...(reason ? { reason } : {}),
  });
  return successResponse(
    {
      userId: targetUserId,
      tier: newTier,
      sessionTokenMayRefreshWithinSeconds: 60,
    },
    { requestId, cacheControl: CACHE_CONTROL.noStore },
  );
}
