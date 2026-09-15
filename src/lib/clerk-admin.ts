// Phase 04 (Part B): injectable Clerk Backend API seam for admin writes.
//
// Production talks to Clerk via the lazily-imported `@clerk/nextjs/server`
// `clerkClient` (dedicated `updateUserMetadata`, which wraps
// `PATCH /v1/users/{userId}/metadata` with deep-merge semantics — required
// since API version 2026-05-12, when metadata was rejected on the general
// `updateUser()` path). Tests inject a mock via `setClerkAdminClient` and
// never need live keys. The lazy import keeps this module importable in
// keyless unit tests without initializing the Clerk SDK (same pattern as
// `clerk-auth.ts`).

import { forbiddenResponse, normalizeRole } from "./admin-guard";
import { errorResponse } from "./errors";

/** Minimal Clerk user shape the admin write path needs. */
export interface ClerkPublicMetadata {
  tier?: unknown;
  role?: unknown;
  [key: string]: unknown;
}

export interface ClerkUserRecord {
  id: string;
  publicMetadata?: ClerkPublicMetadata | null;
}

export interface ClerkCallOptions {
  /** Fail-fast signal; callers pass `AbortSignal.timeout(8000)`. */
  signal?: AbortSignal;
}

export interface ClerkAdminClient {
  /** Authoritative read — the write path records old tier/role from this, never from session claims. */
  getUser(userId: string, opts?: ClerkCallOptions): Promise<ClerkUserRecord>;
  /**
   * Dedicated metadata write (deep-merge, `null` removes a key). Callers
   * write ONLY the key they own (tier or role) so a concurrent change to
   * the other field is never clobbered with a stale value.
   */
  updateUserMetadata(
    userId: string,
    params: { publicMetadata: Record<string, string> },
    opts?: ClerkCallOptions,
  ): Promise<ClerkUserRecord>;
}

/**
 * Race a Clerk SDK promise against the caller's fail-fast signal. The SDK
 * takes no signal option, so the race delivers the 8s budget: on abort the
 * caller sees the signal's reason (a `TimeoutError` DOMException for
 * `AbortSignal.timeout`), on settle the abort listener is removed.
 */
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("The operation was aborted."),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("The operation was aborted."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Live backend client. Never imported at module top-level: the Clerk SDK
 * throws without keys, so this resolves (and imports) only when an admin
 * route actually runs against a configured env.
 */
export const liveClerkAdminClient: ClerkAdminClient = {
  async getUser(userId, opts) {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    return withSignal(
      client.users.getUser(userId) as Promise<ClerkUserRecord>,
      opts?.signal,
    );
  },
  async updateUserMetadata(userId, params, opts) {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    return withSignal(
      client.users.updateUserMetadata(
        userId,
        params,
      ) as Promise<ClerkUserRecord>,
      opts?.signal,
    );
  },
};

let current: ClerkAdminClient | undefined;

/** Active client: the test override when set, otherwise the live backend. */
export function getClerkAdminClient(): ClerkAdminClient {
  return current ?? liveClerkAdminClient;
}

/** Swap the active client (used by tests to inject a mock). */
export function setClerkAdminClient(client: ClerkAdminClient): void {
  current = client;
}

/** Reset to the live backend (primarily for tests). */
export function resetClerkAdminClient(): void {
  current = undefined;
}

/** Fail-fast predicate (exported so handlers can reconcile timed-out writes). */
export function isClerkTimeout(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function clerkStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function clerkRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
    ? Math.ceil(retryAfter)
    : undefined;
}

/**
 * Map a Clerk backend failure to a typed JSON error (never a throw — the
 * pipeline would mask it as a 500):
 * - fail-fast fired → 504 `upstream_timeout` (Part A fail-fast language).
 *   The SDK promise cannot be cancelled, so the write may still have landed
 *   server-side — the outcome is unknown until re-fetched.
 * - backend 404 → 404 `user_not_found`.
 * - backend 429 → 429 `rate_limited` with `Retry-After` (code style rules).
 * - backend 401/403 → 503 `dependency_unavailable`: a server-side
 *   getUser/updateUserMetadata rejection describes OUR backend credential,
 *   not the caller, so it must never surface as a caller-facing 4xx.
 * - other backend 4xx (validation faults) → same status as `clerk_rejected`,
 *   never misreported as a 503 outage.
 * - anything else → 503 `dependency_unavailable` (fail closed, never serve
 *   a mutation half-applied as success).
 */
export function clerkErrorResponse(
  requestId: string,
  err: unknown,
): ReturnType<typeof errorResponse> {
  if (isClerkTimeout(err)) {
    return errorResponse(requestId, {
      code: "upstream_timeout",
      message: "Clerk request timed out.",
      hint: "Outcome unknown — re-fetch the user before retrying.",
      status: 504,
    });
  }
  const status = clerkStatus(err);
  if (status === 404) {
    return errorResponse(requestId, {
      code: "user_not_found",
      message: "Target user not found.",
      hint: "Check the userId; it must be an existing Clerk user_xxx id.",
      status: 404,
    });
  }
  if (status === 429) {
    return errorResponse(requestId, {
      code: "rate_limited",
      message: "Rate limit exceeded.",
      hint: "Slow down and retry after the time in Retry-After; the change may not have applied — re-fetch the user before retrying.",
      status: 429,
      retryAfter: clerkRetryAfter(err) ?? 60,
    });
  }
  if (status === 401 || status === 403) {
    return errorResponse(requestId, {
      code: "dependency_unavailable",
      message: "User directory unavailable.",
      hint: "Retry shortly; operators must restore the backend credential. The change may not have applied — re-fetch the user before retrying.",
      status: 503,
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return errorResponse(requestId, {
      code: "clerk_rejected",
      message: "User directory rejected the request.",
      hint: "Check the userId and metadata values, then retry; the change may not have applied — re-fetch the user before retrying.",
      status,
    });
  }
  return errorResponse(requestId, {
    code: "dependency_unavailable",
    message: "User directory unavailable.",
    hint: "Retry shortly; the change may not have applied — re-fetch the user before retrying.",
    status: 503,
  });
}

/**
 * Authoritative caller check (stale-claim window): the session claim lags
 * metadata changes by ~60s, so a just-demoted caller could otherwise still
 * write. Runs AFTER the `requireAdmin` fast-reject and requires the
 * caller's authoritative `publicMetadata.role === "admin"`, else 403.
 * Fails closed — any Clerk failure maps through `clerkErrorResponse`,
 * never fail-open. Returns undefined when the caller is confirmed admin.
 */
export async function requireAuthoritativeAdmin(
  requestId: string,
  clerk: ClerkAdminClient,
  callerUserId: string,
  opts?: ClerkCallOptions,
): Promise<ReturnType<typeof errorResponse> | undefined> {
  let record: ClerkUserRecord;
  try {
    record = await clerk.getUser(callerUserId, opts);
  } catch (err) {
    return clerkErrorResponse(requestId, err);
  }
  if (normalizeRole(record.publicMetadata?.role) !== "admin") {
    return forbiddenResponse(
      requestId,
      "Admin access is no longer valid.",
      "Your admin role changed or the session is stale; sign in again as an admin and retry.",
    );
  }
  return undefined;
}

/**
 * ONE bounded best-effort re-fetch after a timed-out write. The Clerk SDK
 * accepts no AbortSignal, so a timed-out `updateUserMetadata` may still have
 * landed server-side — the handler compares this record against the intended
 * value to decide between "confirmed applied" (audit it) and "unknown".
 * Returns undefined when the re-fetch itself fails.
 */
export async function refetchAfterTimeout(
  clerk: ClerkAdminClient,
  userId: string,
  opts?: ClerkCallOptions,
): Promise<ClerkUserRecord | undefined> {
  try {
    return await clerk.getUser(userId, opts);
  } catch {
    return undefined;
  }
}
