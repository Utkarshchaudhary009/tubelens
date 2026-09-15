// Phase 05 (Part B): Clerk API keys for machine auth.
//
// Clerk is the credential authority — secrets live in Clerk only, are
// returned exactly once at creation, and are never stored, logged, or
// audited here. This module holds:
// - `ApiKeysClient`: the narrow injectable seam (create/list/verify/revoke
//   + authoritative getUser). Production uses the live adapter (lazily
//   imported `@clerk/nextjs/server` clerkClient, same pattern as
//   `clerk-admin.ts`); tests inject a mock via `setApiKeysClient`.
// - `api_key_metadata`: the MVP in-memory metadata store (Clerk is the
//   source of truth; Postgres persist deferred). No plaintext secrets.
// - zod `.strict()` bodies shared by the three admin routes.
//
// The installed SDK (`@clerk/nextjs` ^7, backed by `@clerk/backend`) ships
// the full surface — no adapter gap: `apiKeys.create({ name, subject,
// scopes, claims, secondsUntilExpiration })`, `verify(secret)`,
// `list({ subject, includeInvalid, limit, offset })`,
// `revoke({ apiKeyId, revocationReason })`.

import { z } from "zod";
import { normalizeRole, USER_ID_PATTERN, type UserRole } from "./admin-guard";
import {
  type ClerkCallOptions,
  type ClerkUserRecord,
  clerkErrorResponse,
  withBudget,
} from "./clerk-admin";
import { errorResponse } from "./errors";
import { KNOWN_TIERS, normalizeTier, type Tier } from "./product";

/** Scope token shape (MVP passthrough — no quota.ts cost catalog exists yet,
// Phase 13 scope, so any well-formed token is accepted without cost
// semantics). Lowercase only, max 20 per key. */
export const SCOPE_PATTERN = /^[a-z0-9:_-]{1,64}$/;
export const MAX_SCOPES = 20;

/** Key-id path shape; anything else is 400 `invalid_key_id`. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

/** Expiry window bounds (seconds): ≥60s, ≤2y. Anything else is 400. */
export const MIN_EXPIRY_SECONDS = 60;
export const MAX_EXPIRY_SECONDS = 63_072_000;

/**
 * Claim keys that would smuggle privilege onto a key. `tier`/`role` are the
 * canonical Clerk privilege fields in this codebase — a key binds the
 * subject's authoritative tier at issuance, never a client-supplied one —
 * so their presence in `claims` is a self-grant attempt (403), not data.
 */
const PRIVILEGE_CLAIM_KEYS = new Set(["tier", "role"]);

/** True when `claims` smuggle a privilege field (see above) — the issuance path rejects these with 403. */
export function hasPrivilegeClaims(claims: Record<string, unknown>): boolean {
  return [...PRIVILEGE_CLAIM_KEYS].some((key) => Object.hasOwn(claims, key));
}

// POST /api/v1/admin/keys body. `.strict()` denies smuggled keys (a caller
// cannot slip `role`-adjacent privilege fields past this body); privilege
// *inside* `claims` is rejected separately with 403 (see above).
export const createKeyBodySchema = z
  .object({
    subject: z.string().regex(USER_ID_PATTERN),
    name: z.string().trim().min(1).max(64),
    scopes: z.array(z.string().regex(SCOPE_PATTERN)).max(MAX_SCOPES).optional(),
    secondsUntilExpiration: z
      .number()
      .int()
      .min(MIN_EXPIRY_SECONDS)
      .max(MAX_EXPIRY_SECONDS)
      .optional(),
    claims: z.record(z.string(), z.unknown()).optional(),
    // Optional operator reason (e.g. rotation correlation: the create-new
    // half shares its reason with the revoke-old half). Trimmed so
    // ""/whitespace-only reasons become droppable audit noise; max applies
    // post-trim. Same convention as the Phase 04 tier/role routes.
    reason: z.string().trim().max(280).optional(),
  })
  .strict();

// POST /api/v1/admin/keys/:keyId/revoke body (empty body is normalized to
// `{}` by the route, so revocationReason stays optional here).
export const revokeKeyBodySchema = z
  .object({
    // Trimmed so ""/whitespace-only reasons become droppable audit noise.
    revocationReason: z.string().trim().max(280).optional(),
  })
  .strict();

export type CreateKeyBody = z.infer<typeof createKeyBodySchema>;
export type RevokeKeyBody = z.infer<typeof revokeKeyBodySchema>;

/** Minimal structural issue shape — zod issues satisfy this without importing zod elsewhere. */
export interface KeyBodyIssue {
  path: readonly (string | number | symbol)[];
  code: string;
}

/**
 * Map strict-body zod issues to typed 400 codes (the handler adds
 * `status: 400` via `errorResponse()`):
 * - `subject` violation → `invalid_subject`.
 * - `scopes` (or an element) violation → `invalid_scope`.
 * - `secondsUntilExpiration` violation → `invalid_expiry`.
 * - `claims` violation → `invalid_claims`.
 * - `name` violation → `invalid_name`; `revocationReason` → `invalid_reason`;
 *   smuggled/extra keys (`.strict()`) or anything else → `invalid_body`.
 */
export function mapApiKeyBodyError(issues: readonly KeyBodyIssue[]): {
  code: string;
  message: string;
  hint: string;
} {
  for (const issue of issues) {
    const head = issue.path[0];
    if (head === "subject") {
      return {
        code: "invalid_subject",
        message: "Invalid subject.",
        hint: "Use a Clerk user id like user_abc123; it must match /^user_[A-Za-z0-9]+$/.",
      };
    }
    if (head === "scopes") {
      return {
        code: "invalid_scope",
        message: "Invalid scope.",
        hint: "Use up to 20 scopes matching /^[a-z0-9:_-]{1,64}$/ (lowercase letters, digits, colon, underscore, hyphen).",
      };
    }
    if (head === "secondsUntilExpiration") {
      return {
        code: "invalid_expiry",
        message: "Invalid expiry.",
        hint: `Use an integer number of seconds between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS}, or omit it for a key that never expires.`,
      };
    }
    if (head === "claims") {
      return {
        code: "invalid_claims",
        message: "Invalid claims.",
        hint: "Send claims as a flat JSON object; omit tier and role, which the key binds authoritatively at issuance.",
      };
    }
    if (head === "name") {
      return {
        code: "invalid_name",
        message: "Invalid key name.",
        hint: "Send a non-empty name up to 64 characters.",
      };
    }
    if (head === "revocationReason" || head === "reason") {
      return {
        code: "invalid_reason",
        message: "Invalid reason.",
        hint: "Keep the reason to 280 characters or fewer, or omit it.",
      };
    }
  }
  return {
    code: "invalid_body",
    message: "Invalid request body.",
    hint: "Send only the documented fields; no other keys are accepted.",
  };
}

/** Rank for the self-grant rule (`free < plus < pro < enterprise`, index order of KNOWN_TIERS). */
export function tierRank(tier: Tier): number {
  return KNOWN_TIERS.indexOf(tier);
}

/** Plain key shape crossing the seam (a defensive copy — never an SDK instance). `secret` is present ONLY on creation. */
export interface ApiKeyRecord {
  id: string;
  name: string;
  subject: string;
  scopes: string[];
  claims: Record<string, unknown> | null;
  revoked: boolean;
  revocationReason: string | null;
  expired: boolean;
  expiration: number | null;
  createdBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** Plaintext secret — creation response only. Never stored/logged/audited. */
  secret?: string;
}

export interface CreateKeyParams {
  name: string;
  subject: string;
  scopes?: string[];
  claims?: Record<string, unknown> | null;
  secondsUntilExpiration?: number | null;
  createdBy?: string | null;
}

export interface RevokeKeyParams {
  apiKeyId: string;
  revocationReason?: string | null;
}

/** Narrow injectable seam: key ops plus the authoritative `getUser` the issuance path needs. */
export interface ApiKeysClient {
  /** Authoritative read — `tierAtIssuance` and the caller re-check come from this, never from claims or client input. */
  getUser(userId: string, opts?: ClerkCallOptions): Promise<ClerkUserRecord>;
  createKey(
    params: CreateKeyParams,
    opts?: ClerkCallOptions,
  ): Promise<ApiKeyRecord>;
  listKeys(
    params: { subject: string; includeInvalid?: boolean },
    opts?: ClerkCallOptions,
  ): Promise<ApiKeyRecord[]>;
  revokeKey(
    params: RevokeKeyParams,
    opts?: ClerkCallOptions,
  ): Promise<ApiKeyRecord>;
  /**
   * Verify a plaintext secret. Resolves the key on success; throws on
   * missing/malformed/revoked/expired (callers degrade to anonymous, never
   * fail open). The secret itself is never retained.
   */
  verifyKey(secret: string, opts?: ClerkCallOptions): Promise<ApiKeyRecord>;
}

/** Per-page size for the authority key listing. */
export const KEY_LIST_PAGE_SIZE = 50;
/** Defensive cap on walked list pages — bounds work on a misbehaving authority. */
export const MAX_KEY_LIST_PAGES = 20;

export interface KeyPage<T> {
  data: T[];
  totalCount: number;
}

/**
 * Walk the authority's offset pagination until a short page (or the
 * `totalCount`) ends the walk, combining results. Capped at
 * `MAX_KEY_LIST_PAGES` pages. Exported so tests cover the walk without the
 * Clerk SDK; the live `listKeys` adapter above is its only production caller.
 */
export async function collectKeyPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<KeyPage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_KEY_LIST_PAGES; page++) {
    const res = await fetchPage(page * KEY_LIST_PAGE_SIZE, KEY_LIST_PAGE_SIZE);
    all.push(...res.data);
    if (res.data.length < KEY_LIST_PAGE_SIZE) {
      break;
    }
    if (all.length >= res.totalCount) {
      break;
    }
  }
  return all;
}

function toRecord(raw: {
  id: string;
  name: string;
  subject: string;
  scopes?: string[];
  claims?: Record<string, unknown> | null;
  revoked: boolean;
  revocationReason?: string | null;
  expired: boolean;
  expiration?: number | null;
  createdBy?: string | null;
  createdAt: number;
  lastUsedAt?: number | null;
  secret?: string;
}): ApiKeyRecord {
  return {
    id: raw.id,
    name: raw.name,
    subject: raw.subject,
    scopes: Array.isArray(raw.scopes) ? [...raw.scopes] : [],
    claims:
      raw.claims !== null &&
      typeof raw.claims === "object" &&
      raw.claims !== undefined
        ? { ...(raw.claims as Record<string, unknown>) }
        : null,
    revoked: raw.revoked,
    revocationReason: raw.revocationReason ?? null,
    expired: raw.expired,
    expiration: raw.expiration ?? null,
    createdBy: raw.createdBy ?? null,
    createdAt: raw.createdAt,
    lastUsedAt: raw.lastUsedAt ?? null,
    ...(raw.secret !== undefined ? { secret: raw.secret } : {}),
  };
}

/**
 * Live backend client. Never imported at module top-level: the Clerk SDK
 * throws without keys, so this resolves (and imports) only when an admin
 * key route or the Bearer fallback actually runs against a configured env.
 * Every call runs inside the caller's 8s fail-fast budget via `withBudget`.
 */
export const liveApiKeysClient: ApiKeysClient = {
  async getUser(userId, opts) {
    return withBudget(async () => {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      return (await client.users.getUser(userId)) as ClerkUserRecord;
    }, opts?.signal);
  },
  async createKey(params, opts) {
    return withBudget(async () => {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const created = await client.apiKeys.create({
        name: params.name,
        subject: params.subject,
        ...(params.scopes !== undefined ? { scopes: params.scopes } : {}),
        ...(params.claims !== undefined ? { claims: params.claims } : {}),
        ...(params.secondsUntilExpiration !== undefined
          ? { secondsUntilExpiration: params.secondsUntilExpiration }
          : {}),
        ...(params.createdBy !== undefined && params.createdBy !== null
          ? { createdBy: params.createdBy }
          : {}),
      });
      return toRecord({
        id: created.id,
        name: created.name,
        subject: created.subject,
        scopes: created.scopes,
        claims: created.claims as Record<string, unknown> | null,
        revoked: created.revoked,
        revocationReason: created.revocationReason,
        expired: created.expired,
        expiration: created.expiration,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
        lastUsedAt: created.lastUsedAt,
        secret: created.secret,
      });
    }, opts?.signal);
  },
  async listKeys(params, opts) {
    return withBudget(async () => {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const keys = await collectKeyPages((offset, limit) =>
        client.apiKeys.list({
          subject: params.subject,
          includeInvalid: params.includeInvalid ?? true,
          limit,
          offset,
        }),
      );
      return keys.map((key) =>
        toRecord({
          id: key.id,
          name: key.name,
          subject: key.subject,
          scopes: key.scopes,
          claims: key.claims as Record<string, unknown> | null,
          revoked: key.revoked,
          revocationReason: key.revocationReason,
          expired: key.expired,
          expiration: key.expiration,
          createdBy: key.createdBy,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
        }),
      );
    }, opts?.signal);
  },
  async revokeKey(params, opts) {
    return withBudget(async () => {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const revoked = await client.apiKeys.revoke({
        apiKeyId: params.apiKeyId,
        ...(params.revocationReason !== undefined
          ? { revocationReason: params.revocationReason }
          : {}),
      });
      return toRecord({
        id: revoked.id,
        name: revoked.name,
        subject: revoked.subject,
        scopes: revoked.scopes,
        claims: revoked.claims as Record<string, unknown> | null,
        revoked: revoked.revoked,
        revocationReason: revoked.revocationReason,
        expired: revoked.expired,
        expiration: revoked.expiration,
        createdBy: revoked.createdBy,
        createdAt: revoked.createdAt,
        lastUsedAt: revoked.lastUsedAt,
      });
    }, opts?.signal);
  },
  async verifyKey(secret, opts) {
    return withBudget(async () => {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const client = await clerkClient();
      const verified = await client.apiKeys.verify(secret);
      return toRecord({
        id: verified.id,
        name: verified.name,
        subject: verified.subject,
        scopes: verified.scopes,
        claims: verified.claims as Record<string, unknown> | null,
        revoked: verified.revoked,
        revocationReason: verified.revocationReason,
        expired: verified.expired,
        expiration: verified.expiration,
        createdBy: verified.createdBy,
        createdAt: verified.createdAt,
        lastUsedAt: verified.lastUsedAt,
      });
    }, opts?.signal);
  },
};

let current: ApiKeysClient | undefined;

/** Active client: the test override when set, otherwise the live backend. */
export function getApiKeysClient(): ApiKeysClient {
  return current ?? liveApiKeysClient;
}

/** Swap the active client (used by tests to inject a mock). */
export function setApiKeysClient(client: ApiKeysClient): void {
  current = client;
}

/** Reset to the live backend (primarily for tests). */
export function resetApiKeysClient(): void {
  current = undefined;
}

// ---------------------------------------------------------------------------
// MVP in-memory metadata store (`api_key_metadata`).
//
// Clerk is the source of truth; this process-local map carries the issuance
// context Clerk does not return on list/verify (`tierAtIssuance`, `createdBy`
// as the issuing admin, operator `revocationReason` echo). $0-safe, no
// parallel vault. Postgres persist deferred until a durable need proves it.
// NEVER holds plaintext secrets — records are built field-by-field from
// non-secret values only.
// ---------------------------------------------------------------------------

export interface ApiKeyMetadata {
  keyId: string;
  subject: string;
  name: string;
  scopes: string[];
  tierAtIssuance: Tier;
  createdBy: string;
  /** ISO-8601 issuance timestamp. */
  createdAt: string;
  /** ISO-8601 expiry, or null when the key never expires. */
  expiresAt: string | null;
  revoked: boolean;
  revocationReason?: string;
  /** ISO-8601 last-verify timestamp, or null when never verified here. */
  lastUsedAt: string | null;
}

const metadataStore = new Map<string, ApiKeyMetadata>();

/** Record issuance context (secret-free by construction — no such field exists). */
export function recordKeyMetadata(entry: ApiKeyMetadata): ApiKeyMetadata {
  const stored: ApiKeyMetadata = {
    keyId: entry.keyId,
    subject: entry.subject,
    name: entry.name,
    scopes: [...entry.scopes],
    tierAtIssuance: entry.tierAtIssuance,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    revoked: entry.revoked,
    ...(entry.revocationReason !== undefined
      ? { revocationReason: entry.revocationReason }
      : {}),
    lastUsedAt: entry.lastUsedAt,
  };
  metadataStore.set(stored.keyId, stored);
  return { ...stored, scopes: [...stored.scopes] };
}

export function getKeyMetadata(keyId: string): ApiKeyMetadata | undefined {
  const found = metadataStore.get(keyId);
  return found ? { ...found, scopes: [...found.scopes] } : undefined;
}

/** Mark a key revoked locally (Clerk remains the authority; this keeps the MVP overlay consistent). */
export function markKeyRevoked(keyId: string, revocationReason?: string): void {
  const found = metadataStore.get(keyId);
  if (!found) {
    return;
  }
  found.revoked = true;
  if (revocationReason !== undefined && revocationReason !== "") {
    found.revocationReason = revocationReason;
  }
}

/** Stamp last-verify time (no-op for keys the overlay never saw, e.g. Dashboard-issued). */
export function touchKeyLastUsed(keyId: string, at?: string): void {
  const found = metadataStore.get(keyId);
  if (!found) {
    return;
  }
  found.lastUsedAt = at ?? new Date().toISOString();
}

/** Clear the overlay (primarily for tests). */
export function clearApiKeyMetadata(): void {
  metadataStore.clear();
}

// ---------------------------------------------------------------------------
// Authoritative caller check for the key routes.
// ---------------------------------------------------------------------------

export type AuthoritativeCaller =
  | { ok: true; record: ClerkUserRecord; role: "admin"; tier: Tier }
  | { ok: false; response: ReturnType<typeof errorResponse> };

/**
 * Re-fetch the caller against authoritative metadata (session claims lag
 * ~60s): a just-demoted caller fails closed here, never writes. Returns the
 * record so the create path can also enforce the self-grant tier rule
 * without a second round-trip. Fails closed — any Clerk failure maps through
 * `clerkErrorResponse`, never fail-open.
 */
export async function requireAuthoritativeCaller(
  requestId: string,
  apiKeys: ApiKeysClient,
  callerUserId: string,
  opts?: ClerkCallOptions,
): Promise<AuthoritativeCaller> {
  let record: ClerkUserRecord;
  try {
    record = await apiKeys.getUser(callerUserId, opts);
  } catch (err) {
    return { ok: false, response: clerkErrorResponse(requestId, err) };
  }
  const role: UserRole = normalizeRole(record.publicMetadata?.role);
  if (role !== "admin") {
    return {
      ok: false,
      response: errorResponse(requestId, {
        code: "forbidden",
        message: "Admin access is no longer valid.",
        hint: "Your admin role changed or the session is stale; sign in again as an admin and retry.",
        status: 403,
      }),
    };
  }
  return {
    ok: true,
    record,
    role,
    tier: normalizeTier(record.publicMetadata?.tier),
  };
}
