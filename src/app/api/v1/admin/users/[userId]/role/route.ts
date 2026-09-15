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

// PATCH /api/v1/admin/users/:userId/role — admin-only role change.
// `.strict()` denies smuggled keys (a caller cannot slip `tier`/privilege
// fields past this body). Self-demotion guard: an admin can never move their
// own role off `admin` (actor === target && role !== "admin" → 403) —
// removing the last admin lockout path and any self-escalation vector. There
// is no self-grant endpoint: the first admin is bootstrapped out-of-band via
// the Clerk Dashboard (PLAN Phase 04).
export const roleBodySchema = z
  .object({
    role: z.enum(["admin", "support", "user"]),
    // Trimmed so ""/whitespace-only reasons become droppable audit noise
    // (the handler passes `reason || undefined`); max applies post-trim.
    reason: z.string().trim().max(280).optional(),
  })
  .strict();

export interface RolePatchDeps {
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
          hint: 'Send a JSON body like { "role": "support" } with Content-Type: application/json.',
          status: 400,
        });
      }
      return handleRolePatch(c.requestId, c.auth, userId, rawBody);
    },
    { auth: clerkAuthProvider },
    "admin.users.role",
  )(req);
}

// Pure handler (no HTTP/pipeline): tests inject fake AuthContexts + a mocked
// Clerk seam here and never need live keys; production reaches it via PATCH.
export async function handleRolePatch(
  requestId: string,
  auth: AuthContext,
  targetUserId: string,
  rawBody: unknown,
  deps: RolePatchDeps = {},
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
  const parsed = roleBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const mapped = mapAdminBodyError("role", parsed.error.issues);
    return errorResponse(requestId, { ...mapped, status: 400 });
  }
  const { role: newRole, reason } = parsed.data;
  if (caller.userId === targetUserId && newRole !== "admin") {
    return forbiddenResponse(
      requestId,
      "Self-demotion is not allowed.",
      "Admins cannot change their own role to a non-admin value; ask another admin to make this change.",
    );
  }

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
    // untouched tier survives the role change.
    await clerk.updateUserMetadata(
      targetUserId,
      { publicMetadata: { tier: oldTier, role: newRole } },
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }

  recordAuditEvent({
    action: "user.role.changed",
    actor: caller.userId,
    target: targetUserId,
    targetUserId,
    oldRole,
    newRole,
    requestId,
    ...(reason ? { reason } : {}),
  });
  return successResponse(
    {
      userId: targetUserId,
      role: newRole,
      sessionTokenMayRefreshWithinSeconds: 60,
    },
    { requestId, cacheControl: CACHE_CONTROL.noStore },
  );
}
