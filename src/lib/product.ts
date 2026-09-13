// Canonical product tiers + entitlement snapshot.
// Source of truth: plans/PLANS_AND_USAGE.md — do NOT invent competing tier
// rules here. This module only projects that document into typed policy.

/** Active tier plus reserved future tiers (defined, not active by default). */
export type Tier = "free" | "pro" | "team" | "enterprise";

export const ACTIVE_TIERS: readonly Tier[] = ["free"];
export const KNOWN_TIERS: readonly Tier[] = [
  "free",
  "pro",
  "team",
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

export const FREE_ENTITLEMENTS: EntitlementSnapshot = {
  tier: "free",
  monthlyCredits: 10_000,
  burstRequests: 60,
  burstWindowSeconds: 10,
  policyVersion: FREE_POLICY_VERSION,
};

/**
 * Normalize an untrusted tier value. Only ACTIVE_TIERS are effective —
 * reserved tiers (pro/team/enterprise) are defined but not active, so they
 * fall back to `free` like any unknown value. A tier can never be
 * self-escalated via a forged claim.
 */
export function normalizeTier(raw: unknown): Tier {
  return ACTIVE_TIERS.includes(raw as Tier) ? (raw as Tier) : "free";
}

export interface ProductPolicyProvider {
  /** Effective tier for a principal (Phase 01: always `free`). */
  resolveTier(auth: { userId?: string; type: string }): Tier;
  /** Entitlement snapshot for a tier (Phase 01: free defaults). */
  entitlementsFor(tier: Tier): EntitlementSnapshot;
}

export const defaultProductPolicyProvider: ProductPolicyProvider = {
  resolveTier(): Tier {
    return "free";
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
