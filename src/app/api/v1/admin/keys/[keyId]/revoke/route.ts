import type { NextRequest, NextResponse } from "next/server";
import {
  type ApiKeysClient,
  getApiKeysClient,
  getKeyMetadata,
  KEY_ID_PATTERN,
  mapApiKeyBodyError,
  markKeyRevoked,
  requireAuthoritativeCaller,
  revokeKeyBodySchema,
} from "@/lib/api-keys";
import { recordAuditEvent } from "@/lib/audit";
import {
  type AuthContext,
  forbiddenResponse,
  requireAdmin,
  unauthenticatedResponse,
} from "@/lib/auth";
import { clerkErrorResponse, clerkErrorStatus } from "@/lib/clerk-admin";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { CACHE_CONTROL, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { withRequestContext } from "@/lib/pipeline";
import { readBoundedJson } from "@/lib/validate";

export const runtime = "nodejs";

export interface RevokeKeyDeps {
  apiKeys?: ApiKeysClient;
}

// POST /api/v1/admin/keys/:keyId/revoke — admin-only instant revoke.
// Rotation is client-driven: create-new (POST /admin/keys) + revoke-old
// (this route), audited as one `issued` row plus one `revoked` row.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ keyId: string }> },
): Promise<NextResponse> {
  const { keyId } = await ctx.params;
  return withRequestContext(
    async (r, c) => {
      // The body is optional (bare `POST` revokes without a reason): an
      // empty body normalizes to `{}`, malformed JSON is 400, oversized is
      // 413 — all decided by the bounded reader before any Clerk call.
      const body = await readBoundedJson(r, { emptyValue: {} });
      if (!body.ok) {
        if (body.error.code === "body_too_large") {
          return errorResponse(c.requestId, {
            ...body.error,
            origin: r.headers.get("origin"),
          });
        }
        return errorResponse(c.requestId, {
          code: "invalid_body",
          message: "Request body must be valid JSON.",
          hint: 'Send a JSON body like { "revocationReason": "rotated" } with Content-Type: application/json, or no body at all.',
          status: 400,
          origin: r.headers.get("origin"),
        });
      }
      const rawBody: unknown = body.value;
      return handleAdminKeysRevoke(
        c.requestId,
        c.auth,
        keyId,
        rawBody,
        {},
        r.headers.get("origin"),
      );
    },
    { auth: clerkAuthProvider },
    "admin.keys.revoke",
  )(req);
}

// Pure handler (no HTTP/pipeline): tests inject fake AuthContexts + a mocked
// key seam here and never need live keys; production reaches it via POST.
export async function handleAdminKeysRevoke(
  requestId: string,
  auth: AuthContext,
  keyId: string,
  rawBody: unknown,
  deps: RevokeKeyDeps = {},
  origin?: string | null,
): Promise<NextResponse> {
  const caller = requireAdmin(auth);
  if (!caller.ok) {
    return caller.code === "unauthenticated"
      ? unauthenticatedResponse(requestId, origin)
      : forbiddenResponse(requestId, undefined, undefined, origin);
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    return errorResponse(requestId, {
      code: "invalid_key_id",
      message: "Invalid key id.",
      hint: "Use the keyId returned at issuance; it must be a non-empty token of letters, digits, underscore, hyphen, or colon.",
      status: 400,
      origin: origin ?? null,
    });
  }
  const parsed = revokeKeyBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const mapped = mapApiKeyBodyError(parsed.error.issues);
    return errorResponse(requestId, {
      ...mapped,
      status: 400,
      origin: origin ?? null,
    });
  }
  const revocationReason = parsed.data.revocationReason || undefined;

  // Authoritative write path: session claims lag ~60s, so the CALLER is
  // re-verified against authoritative metadata (a just-demoted caller must
  // fail closed here, never revoke). Fresh 8s budget per Clerk call.
  const apiKeys = deps.apiKeys ?? getApiKeysClient();
  const callerCheck = await requireAuthoritativeCaller(
    requestId,
    apiKeys,
    caller.userId,
    { signal: AbortSignal.timeout(8000) },
    origin,
  );
  if (!callerCheck.ok) {
    return callerCheck.response;
  }
  // Phase 07 ownership pre-check: fetch the local issuance record FIRST so
  // the authority result below can be verified against the recorded
  // subject/owner. Absent overlay (Dashboard-issued keys, or a restarted
  // process) is not an error — the authority stays the source of truth and
  // the check is skipped.
  const known = getKeyMetadata(keyId);
  let revoked: Awaited<ReturnType<ApiKeysClient["revokeKey"]>>;
  try {
    revoked = await apiKeys.revokeKey(
      {
        apiKeyId: keyId,
        ...(revocationReason !== undefined ? { revocationReason } : {}),
      },
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    // A 404 here names the KEY, never the user — `clerkErrorResponse` would
    // misreport it as `user_not_found`.
    if (clerkErrorStatus(err) === 404) {
      return errorResponse(requestId, {
        code: "key_not_found",
        message: "API key not found.",
        hint: "Check the keyId; it must be an existing key issued for a Clerk subject.",
        status: 404,
        origin: origin ?? null,
      });
    }
    return clerkErrorResponse(requestId, err, origin);
  }
  markKeyRevoked(keyId, revocationReason);
  recordAuditEvent({
    action: "api_key.revoked",
    actor: caller.userId,
    target: revoked.subject,
    targetUserId: revoked.subject,
    keyId,
    ...(revocationReason !== undefined
      ? { revocationReason, reason: revocationReason }
      : {}),
    requestId,
  });
  // Phase 07 subject/owner verification: the authority result must agree
  // with the issuance record when one exists. Bookkeeping above is already
  // consistent (the authority revoke DID apply), but a divergent subject
  // means the overlay and the authority disagree about who owns this key —
  // report it as a 409 conflict, never as a clean success.
  if (known && revoked.subject !== known.subject) {
    return errorResponse(requestId, {
      code: "key_owner_mismatch",
      message: "API key ownership record disagrees with the key authority.",
      hint: "The authority revoke was applied, but the key's subject does not match the issuance record; list the subject's keys to reconcile and report the X-Request-Id.",
      status: 409,
      origin: origin ?? null,
    });
  }
  return successResponse(
    {
      keyId,
      revoked: true,
      ...(revocationReason !== undefined ? { revocationReason } : {}),
    },
    { requestId, cacheControl: CACHE_CONTROL.noStore, origin: origin ?? null },
  );
}
