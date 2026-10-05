// Phase 17 (Part B): abuse controls and anomaly detection.
//
// Pins the PLAN thresholds at the `abuse.ts` seam (in-memory counters keyed
// on the rate-limit identity — never IP): failed-auth bursts revoke,
// single-key abuse stays isolated, cooldowns/windows expire, boundary
// workloads pass, anonymous stays warn-only, downgrades never drop below
// free, DRY_RUN never mutates, and ban-queued never auto-executes. A final
// block proves the pipeline glue is response-neutral (429 shape unchanged).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  ABUSE_AUTH_FAIL_REVOKE_AT,
  ABUSE_BATCH_REJECT_WARN_AT,
  ABUSE_RATE_LIMIT_REVOKE_AT,
  ABUSE_RATE_LIMIT_WARN_AT,
  ABUSE_TIMEOUT_WARN_AT,
  ABUSE_VALIDATION_WARN_AT,
  type AbuseOutcome,
  checkAbuse,
  clearAbuseState,
  downgradeTier,
  enforceAbuseVerdict,
  isAbuseDryRun,
  isAbuseExemptRoute,
  noteAbuseOutcome,
} from "../abuse";
import type { ApiKeysClient } from "../api-keys";
import {
  type AbuseAuditEvent,
  clearAuditEvents,
  getAuditEvents,
} from "../audit";
import type { ClerkAdminClient, ClerkUserRecord } from "../clerk-admin";
import {
  noopObservabilityProvider,
  resetObservabilityProvider,
  setObservabilityProvider,
} from "../observability";
import { withRequestContext } from "../pipeline";
import type { Tier } from "../product";
import type { RateLimitProvider } from "../rate-limit";

const T0 = 1_750_000_000_000;
const MIN = 60_000;

const savedDryRun = process.env.DRY_RUN;

beforeEach(() => {
  clearAbuseState();
  clearAuditEvents();
});

afterEach(() => {
  resetObservabilityProvider();
  if (savedDryRun === undefined) {
    delete process.env.DRY_RUN;
  } else {
    process.env.DRY_RUN = savedDryRun;
  }
});

/** Drive `n` outcomes for a principal at one timestamp; return all verdicts. */
function drive(
  principal: string,
  outcome: AbuseOutcome,
  n: number,
  nowMs = T0,
  route?: string,
): string[] {
  const verdicts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    verdicts.push(noteAbuseOutcome({ principal, outcome, nowMs, route }));
  }
  return verdicts;
}

function abuseRows(): AbuseAuditEvent[] {
  return getAuditEvents().filter((row): row is AbuseAuditEvent =>
    row.action.startsWith("abuse."),
  );
}

// ---------------------------------------------------------------------------
// Thresholds + isolation + expiry.
// ---------------------------------------------------------------------------

describe("abuse thresholds", () => {
  test("failed-auth burst revokes at 5 and cools down", () => {
    const first = drive("user:u_auth", "auth_failure", 4);
    expect(first.every((v) => v === "ok")).toBe(true);
    expect(
      noteAbuseOutcome({
        principal: "user:u_auth",
        outcome: "auth_failure",
        nowMs: T0,
      }),
    ).toBe("revoke");
    // Cooldown: the next burst inside 15min is suppressed (still counted).
    expect(
      noteAbuseOutcome({
        principal: "user:u_auth",
        outcome: "auth_failure",
        nowMs: T0,
      }),
    ).toBe("ok");
    // Past the window + cooldown the counter restarts at 1.
    expect(
      noteAbuseOutcome({
        principal: "user:u_auth",
        outcome: "auth_failure",
        nowMs: T0 + 16 * MIN,
      }),
    ).toBe("ok");
  });

  test("single-key abuse stays isolated per key", () => {
    const bad = drive("key:k_bad", "rate_limited", ABUSE_RATE_LIMIT_REVOKE_AT);
    expect(bad.at(-1)).toBe("revoke");
    // A different key starts from zero — unaffected by k_bad's revoke.
    expect(
      noteAbuseOutcome({
        principal: "key:k_good",
        outcome: "rate_limited",
        nowMs: T0,
      }),
    ).toBe("ok");
    // One signal already counted above; 8 more stay below the warn bar.
    const good = drive(
      "key:k_good",
      "rate_limited",
      ABUSE_RATE_LIMIT_WARN_AT - 2,
      T0 + 1,
    );
    expect(good.every((v) => v === "ok")).toBe(true);
    // The 10th counted signal warns (per-key counting works); still far
    // from k_bad's revoke rung.
    expect(
      noteAbuseOutcome({
        principal: "key:k_good",
        outcome: "rate_limited",
        nowMs: T0 + 1,
      }),
    ).toBe("warn");
  });

  test("boundary workload is not blocked", () => {
    // 9 × 429 in 10min: below the warn bar — all ok.
    const nine = drive(
      "user:u_edge",
      "rate_limited",
      ABUSE_RATE_LIMIT_WARN_AT - 1,
    );
    expect(nine.every((v) => v === "ok")).toBe(true);
    // 10th: warn only — the response the caller already holds (429 +
    // Retry-After), no state change, far from revoke.
    expect(
      noteAbuseOutcome({
        principal: "user:u_edge",
        outcome: "rate_limited",
        nowMs: T0,
      }),
    ).toBe("warn");
    // Window expiry clears the count: 9 more after 11min are all ok.
    const after = drive(
      "user:u_edge",
      "rate_limited",
      ABUSE_RATE_LIMIT_WARN_AT - 1,
      T0 + 11 * MIN,
    );
    expect(after.every((v) => v === "ok")).toBe(true);
  });

  test("400-spam, batch-reject, and timeout-churn warn (never revoke)", () => {
    expect(
      drive(
        "user:u_400",
        "validation_error",
        ABUSE_VALIDATION_WARN_AT - 1,
      ).every((v) => v === "ok"),
    ).toBe(true);
    expect(
      noteAbuseOutcome({
        principal: "user:u_400",
        outcome: "validation_error",
        nowMs: T0,
      }),
    ).toBe("warn");
    expect(
      drive(
        "user:u_batch",
        "batch_rejected",
        ABUSE_BATCH_REJECT_WARN_AT - 1,
      ).every((v) => v === "ok"),
    ).toBe(true);
    expect(
      noteAbuseOutcome({
        principal: "user:u_batch",
        outcome: "batch_rejected",
        nowMs: T0,
      }),
    ).toBe("warn");
    // Timeout churn: even 3× the warn bar stays warn-only. The tail reads
    // "ok" — the warn rung cools down after firing once (repeat suppression,
    // not re-warning) — and a fresh wave past the cooldown warns again.
    const churn = drive("user:u_slow", "timeout", ABUSE_TIMEOUT_WARN_AT * 3);
    expect(churn.includes("revoke")).toBe(false);
    expect(churn.includes("downgrade")).toBe(false);
    expect(churn.includes("warn")).toBe(true);
    expect(
      drive("user:u_slow", "timeout", ABUSE_TIMEOUT_WARN_AT, T0 + 11 * MIN).at(
        -1,
      ),
    ).toBe("warn");
  });

  test("exempt routes are never counted", () => {
    for (const route of ["health", "openapi", "admin.keys.list"]) {
      expect(isAbuseExemptRoute(route)).toBe(true);
      const verdicts = drive("user:u_ops", "rate_limited", 30, T0, route);
      expect(verdicts.every((v) => v === "ok")).toBe(true);
    }
    expect(isAbuseExemptRoute("search")).toBe(false);
    expect(isAbuseExemptRoute(undefined)).toBe(false);
    // The principal above accrued nothing: 10 counted signals warn.
    const counted = drive(
      "user:u_ops",
      "rate_limited",
      ABUSE_RATE_LIMIT_WARN_AT,
      T0 + MIN,
    );
    expect(counted.at(-1)).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Anonymous warn-only.
// ---------------------------------------------------------------------------

describe("anonymous shared bucket", () => {
  test("warn-only no matter the volume or signal", () => {
    const verdicts = drive(
      "anonymous",
      "rate_limited",
      ABUSE_RATE_LIMIT_REVOKE_AT + 5,
    );
    expect(verdicts.includes("revoke")).toBe(false);
    expect(verdicts.includes("downgrade")).toBe(false);
    expect(verdicts.includes("warn")).toBe(true);
    // Quota-empty ×3 on anonymous warns, never downgrades.
    clearAbuseState();
    expect(
      drive("anonymous", "quota_exhausted", 2).every((v) => v === "ok"),
    ).toBe(true);
    expect(
      noteAbuseOutcome({
        principal: "anonymous",
        outcome: "quota_exhausted",
        nowMs: T0,
      }),
    ).toBe("warn");
    expect(
      enforceAbuseVerdict({
        verdict: "revoke",
        principal: "anonymous",
        requestId: "r1",
        reason: "burst",
      }),
    ).resolves.toEqual(expect.objectContaining({ enforced: false }));
  });
});

// ---------------------------------------------------------------------------
// Quota-empty streak → downgrade.
// ---------------------------------------------------------------------------

describe("quota-empty downgrade", () => {
  test("three consecutive empty windows downgrade; a consume resets", () => {
    expect(
      drive("user:u_quota", "quota_exhausted", 2).every((v) => v === "ok"),
    ).toBe(true);
    // A successful consume proves allowance remains — streak resets.
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_consumed",
        nowMs: T0,
      }),
    ).toBe("ok");
    expect(
      drive("user:u_quota", "quota_exhausted", 2, T0 + 1).every(
        (v) => v === "ok",
      ),
    ).toBe(true);
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0 + 1,
      }),
    ).toBe("downgrade");
  });

  test("downgrade steps one tier and never below free", () => {
    expect(downgradeTier("enterprise")).toBe("pro");
    expect(downgradeTier("pro")).toBe("plus");
    expect(downgradeTier("plus")).toBe("free");
    expect(downgradeTier("free")).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// Enforcement doubles (Clerk seams stay injectable, 8s budget).
// ---------------------------------------------------------------------------

interface ClerkDouble extends ClerkAdminClient {
  getUserCalls: string[];
  metadataUpdates: Array<{ userId: string; tier: string }>;
  revokedSessions: string[];
  tier: Tier;
  failGetUserStatus?: number;
}

function mockClerk(tier: Tier): ClerkDouble {
  const double: ClerkDouble = {
    getUserCalls: [],
    metadataUpdates: [],
    revokedSessions: [],
    tier,
    async getUser(userId: string): Promise<ClerkUserRecord> {
      double.getUserCalls.push(userId);
      if (double.failGetUserStatus !== undefined) {
        throw { status: double.failGetUserStatus };
      }
      return { id: userId, publicMetadata: { tier: double.tier } };
    },
    async updateUserMetadata(
      userId: string,
      params: { publicMetadata: Record<string, string> },
    ): Promise<ClerkUserRecord> {
      double.metadataUpdates.push({
        userId,
        tier: params.publicMetadata.tier ?? "",
      });
      return {
        id: userId,
        publicMetadata: { tier: params.publicMetadata.tier },
      };
    },
    async revokeSession(sessionId: string): Promise<unknown> {
      double.revokedSessions.push(sessionId);
      return { id: sessionId, status: "revoked" };
    },
  };
  return double;
}

function mockKeys(): {
  client: ApiKeysClient;
  revoked: Array<{ apiKeyId: string; revocationReason: string | null }>;
} {
  const revoked: Array<{ apiKeyId: string; revocationReason: string | null }> =
    [];
  const fail = async (): Promise<never> => {
    throw new Error("unused seam");
  };
  const client: ApiKeysClient = {
    getUser: fail,
    createKey: fail,
    listKeys: async () => ({ keys: [], truncated: false }),
    revokeKey: async (params) => {
      revoked.push({
        apiKeyId: params.apiKeyId,
        revocationReason: params.revocationReason ?? null,
      });
      return {
        id: params.apiKeyId,
        name: "k",
        subject: "user_x",
        scopes: [],
        claims: null,
        revoked: true,
        revocationReason: params.revocationReason ?? null,
        expired: false,
        expiration: null,
        createdBy: null,
        createdAt: 0,
        lastUsedAt: null,
      };
    },
    verifyKey: fail,
  };
  return { client, revoked };
}

describe("enforcement", () => {
  test("revoke ends one session after an authoritative re-check", async () => {
    const clerk = mockClerk("pro");
    const result = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "user:u_1",
      requestId: "req-1",
      reason: "credential spraying",
      sessionId: "sess_1",
      clerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(result).toEqual(
      expect.objectContaining({ enforced: true, dryRun: false }),
    );
    expect(clerk.getUserCalls).toEqual(["u_1"]);
    expect(clerk.revokedSessions).toEqual(["sess_1"]);
    const rows = abuseRows().filter((row) => row.action === "abuse.revoked");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      actor: "system",
      targetUserId: "u_1",
      requestId: "req-1",
    });
  });

  test("revoke without a session id audits but never mutates", async () => {
    const clerk = mockClerk("pro");
    const result = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "user:u_2",
      requestId: "req-2",
      reason: "credential spraying",
      clerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(result.enforced).toBe(false);
    expect(clerk.revokedSessions).toEqual([]);
    expect(clerk.metadataUpdates).toEqual([]);
    expect(abuseRows().some((row) => row.action === "abuse.revoked")).toBe(
      true,
    );
  });

  test("revoke ends one API key with a reason and never logs the secret", async () => {
    const { client, revoked } = mockKeys();
    const result = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "key:key_abc",
      requestId: "req-3",
      reason: "key abused with pasted ak_test_secretXYZ",
      keys: client,
      signal: AbortSignal.timeout(8000),
    });
    expect(result.enforced).toBe(true);
    expect(revoked.length).toBe(1);
    expect(revoked[0]?.apiKeyId).toBe("key_abc");
    expect(revoked[0]?.revocationReason ?? "").not.toContain(
      "ak_test_secretXYZ",
    );
    const logged = JSON.stringify(getAuditEvents());
    expect(logged).not.toContain("ak_test_secretXYZ");
  });

  test("downgrade steps the authoritative tier; free stays free", async () => {
    const clerk = mockClerk("pro");
    const result = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_3",
      requestId: "req-4",
      reason: "quota empty three windows running",
      clerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(result.enforced).toBe(true);
    expect(clerk.metadataUpdates).toEqual([{ userId: "u_3", tier: "plus" }]);
    const rows = abuseRows().filter((row) => row.action === "abuse.downgraded");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ oldTier: "pro", newTier: "plus" });

    const freeClerk = mockClerk("free");
    const freeResult = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_4",
      requestId: "req-5",
      reason: "quota empty three windows running",
      clerk: freeClerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(freeResult.enforced).toBe(false);
    expect(freeClerk.metadataUpdates).toEqual([]);
  });

  test("DRY_RUN=1 logs and audits but never mutates", async () => {
    process.env.DRY_RUN = "1";
    expect(isAbuseDryRun()).toBe(true);
    const clerk = mockClerk("enterprise");
    const { client, revoked } = mockKeys();
    const keyResult = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "key:key_dry",
      requestId: "req-dry-1",
      reason: "monitor mode",
      keys: client,
    });
    expect(keyResult).toEqual(
      expect.objectContaining({ enforced: false, dryRun: true }),
    );
    expect(revoked).toEqual([]);
    const tierResult = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_dry",
      requestId: "req-dry-2",
      reason: "monitor mode",
      clerk,
    });
    expect(tierResult).toEqual(
      expect.objectContaining({ enforced: false, dryRun: true }),
    );
    expect(clerk.metadataUpdates).toEqual([]);
  });

  test("ban-queued never auto-executes", () => {
    // Three revoke cycles (cooldown gaps between) escalate to ban-queued.
    let nowMs = T0;
    let verdict = "ok";
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let i = 0; i < ABUSE_AUTH_FAIL_REVOKE_AT; i += 1) {
        verdict = checkAbuse({
          principal: "user:u_ban",
          signal: "auth_failure",
          nowMs,
        });
      }
      nowMs += 20 * MIN;
    }
    expect(verdict).toBe("ban-queued");
    expect(abuseRows().some((row) => row.action === "abuse.ban_queued")).toBe(
      true,
    );
  });

  test("enforcing ban-queued performs no mutation", async () => {
    const clerk = mockClerk("pro");
    const result = await enforceAbuseVerdict({
      verdict: "ban-queued",
      principal: "user:u_ban",
      requestId: "req-ban",
      reason: "manual approval pending",
      clerk,
    });
    expect(result.enforced).toBe(false);
    expect(clerk.revokedSessions).toEqual([]);
    expect(clerk.metadataUpdates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline glue: response-neutral.
// ---------------------------------------------------------------------------

describe("pipeline abuse glue", () => {
  function denyAll(seen: Array<{ identity: string }>): RateLimitProvider {
    return {
      check(check) {
        seen.push({ identity: check.identity });
        return {
          allowed: false,
          limit: 100,
          remaining: 0,
          reset: Math.floor(Date.now() / 1000) + 60,
          retryAfter: 60,
        };
      },
    };
  }

  function getReq(): NextRequest {
    return new NextRequest("http://x/api/v1/search?q=hi", {
      headers: { "x-request-id": "p17-glue" },
    });
  }

  test("a 429 keeps its shape, Retry-After, and X-RateLimit-*", async () => {
    const seen: Array<{ identity: string }> = [];
    const run = withRequestContext(
      async () => {
        throw new Error("must not run when denied");
      },
      { rateLimit: denyAll(seen) },
      "search",
    );
    const res = await run(getReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-Request-Id")).toBe("p17-glue");
    const body = (await res.json()) as {
      error: { code: string; status: number };
      meta: { requestId: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.meta.requestId).toBe("p17-glue");
  });

  test("repeated pipeline 429s emit abuse metrics without changing responses", async () => {
    const increments: string[] = [];
    setObservabilityProvider({
      ...noopObservabilityProvider,
      increment: (name: string) => {
        increments.push(name);
      },
    });
    const run = withRequestContext(
      async () => {
        throw new Error("must not run when denied");
      },
      { rateLimit: denyAll([]) },
      "search",
    );
    for (let i = 0; i < ABUSE_RATE_LIMIT_WARN_AT; i += 1) {
      const res = await run(getReq());
      expect(res.status).toBe(429);
    }
    expect(increments).toContain("abuse.warned");
  });
});
