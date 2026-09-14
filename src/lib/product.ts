// Canonical product tiers + entitlement snapshot.
// Source of truth: plans/PLANS_AND_USAGE.md — do NOT invent competing tier
// rules here. This module only projects that document into typed policy.

/** Canonical tiers, ranked `free < plus < pro < enterprise` (`team` is an org concept, never a tier). */
export type Tier = "free" | "plus" | "pro" | "enterprise";

export const ACTIVE_TIERS: readonly Tier[] = ["free"];
export const KNOWN_TIERS: readonly Tier[] = [
  "free",
  "plus",
  "pro",
  "enterprise",
];

export const FREE_POLICY_VERSION = "2026-09-13.free.v1";

/** Minimal entitlement snapshot derived from the effective tier. */
export interface EntitlementSnapshot {
  tier: Tier;
  /** Monthly weighted-credit allowance (PLANS_AND_USAGE.md §8). */
  monthlyCredits: number;
  /** Burst allowance: requests per windowSeconds. */
  burstRequests: number;
  burstWindowSeconds: number;
  /** Policy version pinned to usage records so history stays explainable. */
  policyVersion: string;
}

// Frozen: the canonical snapshot must never be mutated in place —
// entitlementsFor hands out a fresh copy per request, so a poisoned
// canonical would otherwise propagate to every subsequent caller.
export const FREE_ENTITLEMENTS: Readonly<EntitlementSnapshot> = Object.freeze({
  tier: "free",
  monthlyCredits: 10_000,
  burstRequests: 60,
  burstWindowSeconds: 10,
  policyVersion: FREE_POLICY_VERSION,
});

/**
 * Normalize an untrusted tier value. Any canonical known tier
 * (free/plus/pro/enterprise) is accepted as-is; unknown values — including
 * `team`, which is an org concept and never a tier — fall back to `free`.
 * Non-free labels grant no extra allowance in Phase 01 (entitlementsFor
 * projects the free snapshot), so a forged claim can never self-escalate.
 */
export function normalizeTier(raw: unknown): Tier {
  return KNOWN_TIERS.includes(raw as Tier) ? (raw as Tier) : "free";
}

// Clerk session-token template (Dashboard → Sessions → Customize session
// token), the fast projection read by `getEffectiveTier` below:
//   {"metadata":"{{user.public_metadata}}","tubelens":{"tier":"{{user.public_metadata.tier}}"}}
// Keep total custom claims under 1.2KB (browser cookie size limits).
// Prefer single small fields over copying large objects into the token.

/**
 * Resolve the effective tier from an untrusted Clerk session-claims object.
 *
 * Reads `claims.tubelens.tier` and passes it through `normalizeTier`:
 * missing/invalid/`team`/non-string values fall back to `free`, so a
 * forged or absent claim can never self-escalate. Never throws — any
 * malformed input (null, non-object, throwing getter) resolves `free`.
 *
 * Freshness note: the session claim is a fast, ~60s-stale projection of
 * the authoritative Clerk `publicMetadata.tier`. Normal requests may use
 * it; security-sensitive write paths must re-fetch authoritative Clerk
 * metadata via `getUser` (Phase 04), never trust a stale claim alone.
 */
export function getEffectiveTier(sessionClaims: unknown): Tier {
  try {
    if (typeof sessionClaims !== "object" || sessionClaims === null) {
      return "free";
    }
    const tubelens = (sessionClaims as { tubelens?: unknown }).tubelens;
    if (typeof tubelens !== "object" || tubelens === null) {
      return "free";
    }
    return normalizeTier((tubelens as { tier?: unknown }).tier);
  } catch {
    return "free";
  }
}

export interface ProductPolicyProvider {
  /**
   * Effective tier for a principal (Phase 03: the claim-projected tier
   * carried on `auth.tier` by `clerkAuthProvider`, else `free`).
   */
  resolveTier(auth: { userId?: string; type: string; tier?: unknown }): Tier;
  /** Entitlement snapshot for a tier (Phase 01: free defaults). */
  entitlementsFor(tier: Tier): EntitlementSnapshot;
}

export const defaultProductPolicyProvider: ProductPolicyProvider = {
  resolveTier(auth): Tier {
    // Per-request claim override: the Clerk provider normalizes the
    // session claim onto `auth.tier`; anonymous and legacy contexts carry
    // no tier and stay `free` (byte-identical anonymous contract).
    return normalizeTier(auth.tier);
  },
  entitlementsFor(tier: Tier): EntitlementSnapshot {
    if (tier === "free") {
      return { ...FREE_ENTITLEMENTS };
    }
    // Reserved tiers have no active policy yet — project the free snapshot
    // with the requested tier label so callers stay typed without granting
    // unapproved allowance.
    return { ...FREE_ENTITLEMENTS, tier };
  },
};

let current: ProductPolicyProvider = defaultProductPolicyProvider;

export function setProductPolicyProvider(
  provider: ProductPolicyProvider,
): void {
  current = provider;
}

export function getProductPolicyProvider(): ProductPolicyProvider {
  return current;
}

export function resetProductPolicyProvider(): void {
  current = defaultProductPolicyProvider;
}
