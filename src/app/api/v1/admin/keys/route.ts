import type { NextRequest, NextResponse } from "next/server";
import {
  type ApiKeysClient,
  createKeyBodySchema,
  getApiKeysClient,
  getKeyMetadata,
  hasPrivilegeClaims,
  mapApiKeyBodyError,
  markKeyRevoked,
  recordKeyMetadata,
  requireAuthoritativeCaller,
  tierRank,
} from "@/lib/api-keys";
import { recordAuditEvent } from "@/lib/audit";
import {
  type AuthContext,
  forbiddenResponse,
  requireAdmin,
  USER_ID_PATTERN,
  unauthenticatedResponse,
} from "@/lib/auth";
import { clerkErrorResponse } from "@/lib/clerk-admin";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { CACHE_CONTROL, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { withRequestContext } from "@/lib/pipeline";
import { normalizeTier } from "@/lib/product";

export const runtime = "nodejs";

export interface AdminKeysDeps {
  apiKeys?: ApiKeysClient;
}

// POST /api/v1/admin/keys — admin-only key issuance. Binds `tierAtIssuance`
// from the subject's authoritative metadata (never client-supplied) and
// returns the plaintext secret EXACTLY ONCE in this response — it is never
// stored, logged, or audited.
export async function POST(req: NextRequest): Promise<NextResponse> {
  return withRequestContext(
    async (r, c) => {
      let rawBody: unknown;
      try {
        rawBody = await r.json();
      } catch {
        return errorResponse(c.requestId, {
          code: "invalid_body",
          message: "Request body must be valid JSON.",
          hint: 'Send a JSON body like { "subject": "user_abc123", "name": "cron" } with Content-Type: application/json.',
          status: 400,
        });
      }
      return handleAdminKeysCreate(c.requestId, c.auth, rawBody);
    },
    { auth: clerkAuthProvider },
    "admin.keys.create",
  )(req);
}

// GET /api/v1/admin/keys?subject=user_xxx — admin-only key metadata list
// (never secrets). `subject` is required.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withRequestContext(
    async (r, c) =>
      handleAdminKeysList(
        c.requestId,
        c.auth,
        r.nextUrl.searchParams.get("subject"),
      ),
    { auth: clerkAuthProvider },
    "admin.keys.list",
  )(req);
}

// Pure handlers (no HTTP/pipeline): tests inject fake AuthContexts + a mocked
// key seam here and never need live keys; production reaches them via POST/GET.

export async function handleAdminKeysCreate(
  requestId: string,
  auth: AuthContext,
  rawBody: unknown,
  deps: AdminKeysDeps = {},
): Promise<NextResponse> {
  const caller = requireAdmin(auth);
  if (!caller.ok) {
    return caller.code === "unauthenticated"
      ? unauthenticatedResponse(requestId)
      : forbiddenResponse(requestId);
  }
  const parsed = createKeyBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const mapped = mapApiKeyBodyError(parsed.error.issues);
    return errorResponse(requestId, { ...mapped, status: 400 });
  }
  const {
    subject,
    name,
    scopes = [],
    secondsUntilExpiration,
    claims,
    reason,
  } = parsed.data;
  // Privilege smuggling inside `claims`: keys bind the subject's
  // authoritative tier at issuance — a client-supplied tier/role is a
  // self-grant attempt (403), never data.
  if (claims !== undefined && hasPrivilegeClaims(claims)) {
    return forbiddenResponse(
      requestId,
      "Keys cannot carry tier or role claims.",
      "Omit tier and role from claims; the key binds the subject's authoritative tier at issuance.",
    );
  }

  // Authoritative write path: session claims lag ~60s, so the CALLER is
  // re-verified against authoritative metadata (a just-demoted caller must
  // fail closed here, never mint). Each Clerk call mints its own 8s budget:
  // sharing one signal would let an earlier call eat into a later call's
  // fail-fast window.
  const apiKeys = deps.apiKeys ?? getApiKeysClient();
  const callerCheck = await requireAuthoritativeCaller(
    requestId,
    apiKeys,
    caller.userId,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!callerCheck.ok) {
    return callerCheck.response;
  }
  // Subject read: existence check + authoritative `tierAtIssuance` (never a
  // client-supplied tier).
  let tierAtIssuance: ReturnType<typeof normalizeTier>;
  try {
    const record = await apiKeys.getUser(subject, {
      signal: AbortSignal.timeout(8000),
    });
    tierAtIssuance = normalizeTier(record.publicMetadata?.tier);
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }
  // Self-grant rule: a caller cannot mint a key bound above their own
  // authoritative tier.
  if (tierRank(tierAtIssuance) > tierRank(callerCheck.tier)) {
    return forbiddenResponse(
      requestId,
      "Cannot issue a key above your own tier.",
      "The subject's authoritative tier exceeds yours; ask a higher-tier admin to issue this key.",
    );
  }
  let created: Awaited<ReturnType<ApiKeysClient["createKey"]>>;
  try {
    created = await apiKeys.createKey(
      {
        name,
        subject,
        scopes,
        ...(claims !== undefined ? { claims } : {}),
        ...(secondsUntilExpiration !== undefined
          ? { secondsUntilExpiration }
          : {}),
        createdBy: caller.userId,
      },
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }
  if (!created.secret) {
    // Orphan cleanup: the authority minted a key but withheld its secret,
    // leaving an unusable credential behind. Best-effort revoke it so a
    // retry cannot pile up orphan keys. (No request-backed idempotency is
    // possible: Clerk `apiKeys.create` takes no idempotency key, so cleanup
    // — not dedup — is the guard.) A dedicated code (not the generic
    // dependency mapping) so operators can distinguish an authority contract
    // break from an outage.
    let cleanupFailed = false;
    try {
      await apiKeys.revokeKey(
        { apiKeyId: created.id, revocationReason: "missing-secret cleanup" },
        { signal: AbortSignal.timeout(8000) },
      );
      markKeyRevoked(created.id, "missing-secret cleanup");
    } catch {
      cleanupFailed = true;
    }
    return errorResponse(requestId, {
      code: "key_authority_error",
      message: "Key authority did not return a secret.",
      hint: cleanupFailed
        ? "Issuance outcome is unknown — the orphan key may still exist. List the subject's keys to reconcile before retrying; report the X-Request-Id if the failure persists."
        : "The unusable key was revoked — list the subject's keys to confirm, then retry; report the X-Request-Id if the failure persists.",
      status: 503,
    });
  }
  const issuedAt = new Date().toISOString();
  recordKeyMetadata({
    keyId: created.id,
    subject,
    name,
    scopes: [...scopes],
    tierAtIssuance,
    createdBy: caller.userId,
    createdAt: issuedAt,
    expiresAt:
      created.expiration !== null && created.expiration !== undefined
        ? new Date(created.expiration).toISOString()
        : null,
    revoked: false,
    lastUsedAt: null,
  });
  recordAuditEvent({
    action: "api_key.issued",
    actor: caller.userId,
    target: subject,
    targetUserId: subject,
    keyId: created.id,
    name,
    scopes: [...scopes],
    tierAtIssuance,
    requestId,
    // Rotation correlation: the create-new half shares its reason with the
    // revoke-old half (whitespace-only reasons were trimmed to "" by the
    // schema and are dropped here, same as the tier/role routes).
    ...(reason ? { reason } : {}),
  });
  return successResponse(
    {
      keyId: created.id,
      // The secret appears EXACTLY ONCE (this body). It is never stored in
      // `api_key_metadata`, never audited, never logged.
      secret: created.secret,
      subject,
      name,
      scopes: [...scopes],
      tierAtIssuance,
      expiresAt:
        created.expiration !== null && created.expiration !== undefined
          ? new Date(created.expiration).toISOString()
          : null,
      createdBy: caller.userId,
    },
    { requestId, cacheControl: CACHE_CONTROL.noStore },
  );
}

export async function handleAdminKeysList(
  requestId: string,
  auth: AuthContext,
  subjectParam: string | null,
  deps: AdminKeysDeps = {},
): Promise<NextResponse> {
  const caller = requireAdmin(auth);
  if (!caller.ok) {
    return caller.code === "unauthenticated"
      ? unauthenticatedResponse(requestId)
      : forbiddenResponse(requestId);
  }
  if (!subjectParam || !USER_ID_PATTERN.test(subjectParam)) {
    return errorResponse(requestId, {
      code: "invalid_subject",
      message: "Invalid subject.",
      hint: "Pass ?subject=user_abc123; it must match /^user_[A-Za-z0-9]+$/.",
      status: 400,
    });
  }
  const apiKeys = deps.apiKeys ?? getApiKeysClient();
  const callerCheck = await requireAuthoritativeCaller(
    requestId,
    apiKeys,
    caller.userId,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!callerCheck.ok) {
    return callerCheck.response;
  }
  let keys: Awaited<ReturnType<ApiKeysClient["listKeys"]>>;
  try {
    keys = await apiKeys.listKeys(
      { subject: subjectParam, includeInvalid: true },
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }
  // Metadata only — fields are picked explicitly so a `secret` can never
  // leak through, even if the authority ever returns one on list. The local
  // overlay contributes `tierAtIssuance` (null for keys issued outside this
  // API or before a process restart — Clerk stays the source of truth).
  return successResponse(
    keys.map((key) => ({
      keyId: key.id,
      name: key.name,
      subject: key.subject,
      scopes: [...key.scopes],
      claims: key.claims ? { ...key.claims } : null,
      revoked: key.revoked,
      revocationReason: key.revocationReason,
      expired: key.expired,
      expiration:
        key.expiration !== null && key.expiration !== undefined
          ? new Date(key.expiration).toISOString()
          : null,
      createdBy: key.createdBy,
      createdAt: new Date(key.createdAt).toISOString(),
      lastUsedAt:
        key.lastUsedAt !== null && key.lastUsedAt !== undefined
          ? new Date(key.lastUsedAt).toISOString()
          : null,
      tierAtIssuance: getKeyMetadata(key.id)?.tierAtIssuance ?? null,
    })),
    { requestId, cacheControl: CACHE_CONTROL.noStore },
  );
}
