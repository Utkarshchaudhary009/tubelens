// Phase 01 platform boundary: distributed rate-limit seam.
// The Redis-backed sliding-window/token-bucket engine lands in Phase 12.
// Until then the allow-all default keeps every route serving while the
// pipeline boundary (decision type + headers) stays stable and testable.

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds, per DX_PRINCIPLES.md X-RateLimit-Reset. */
  reset: number;
  /** Seconds — set when allowed === false (429s carry Retry-After). */
  retryAfter?: number;
}

export interface RateLimitCheck {
  /** Logical principal the limit applies to (anon IP, user, key...). */
  identity: string;
  /** Endpoint class for per-class policy (Phase 12+); default "default". */
  endpointClass?: string;
  /** Weighted cost of the operation (Phase 13+); default 1. */
  cost?: number;
}

export interface RateLimitProvider {
  check(check: RateLimitCheck): Promise<RateLimitDecision> | RateLimitDecision;
}

function allowDecision(): RateLimitDecision {
  return {
    allowed: true,
    limit: 100,
    remaining: 99,
    reset: Math.floor(Date.now() / 1000) + 60,
  };
}

/**
 * Shared default allow decision (matches the Part A stub headers: 100/99).
 * Used by the allow-all provider and by the pipeline's liveness bypass so
 * both paths stamp identical values.
 */
export function defaultRateLimitDecision(): RateLimitDecision {
  return allowDecision();
}

/** Phase 01 default: allow everything (matches the Part A stub headers). */
export const allowAllRateLimitProvider: RateLimitProvider = {
  check(): RateLimitDecision {
    return allowDecision();
  },
};

let current: RateLimitProvider = allowAllRateLimitProvider;

export function setRateLimitProvider(provider: RateLimitProvider): void {
  current = provider;
}

export function getRateLimitProvider(): RateLimitProvider {
  return current;
}

export function resetRateLimitProvider(): void {
  current = allowAllRateLimitProvider;
}
