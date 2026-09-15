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
   * pass BOTH tier+role so the untouched key is preserved.
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

function isTimeout(err: unknown): boolean {
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
 *   server-side with no audit row — callers must re-fetch before retrying.
 * - backend 404 → 404 `user_not_found`.
 * - backend 429 → 429 `rate_limited` with `Retry-After` (code style rules).
 * - other backend 4xx (validation faults) → same status as `clerk_rejected`,
 *   never misreported as a 503 outage.
 * - anything else → 503 `dependency_unavailable` (fail closed, never serve
 *   a mutation half-applied as success).
 */
export function clerkErrorResponse(
  requestId: string,
  err: unknown,
): ReturnType<typeof errorResponse> {
  if (isTimeout(err)) {
    return errorResponse(requestId, {
      code: "upstream_timeout",
      message: "Clerk request timed out.",
      hint: "Retry shortly; the change may not have applied — re-fetch the user before retrying.",
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
