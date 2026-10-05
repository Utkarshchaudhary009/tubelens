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
import { contextFromClerkSession } from "../clerk-auth";
import { errorResponse } from "../errors";
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
    // Quota-empty ×3 on anonymous warns, never downgrades (distinct
    // monthly windows — repeats inside one window are a single observation).
    clearAbuseState();
    expect(
      noteAbuseOutcome({
        principal: "anonymous",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w1",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "anonymous",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w2",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "anonymous",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w3",
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
  test("three consecutive DISTINCT windows downgrade; a consume resets", () => {
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "2026-07",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "2026-08",
      }),
    ).toBe("ok");
    // A successful consume proves allowance remains — streak resets.
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_consumed",
        nowMs: T0,
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0 + 1,
        quotaWindowId: "2026-09",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0 + 1,
        quotaWindowId: "2026-10",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_quota",
        outcome: "quota_exhausted",
        nowMs: T0 + 1,
        quotaWindowId: "2026-11",
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

  test("revoke without a session id warns truthfully but never mutates", async () => {
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
    // Truthful audit: nothing was revoked, so the row is `abuse.warned`
    // (deferred to an operator), never `abuse.revoked`.
    expect(abuseRows().some((row) => row.action === "abuse.revoked")).toBe(
      false,
    );
    expect(abuseRows().some((row) => row.action === "abuse.warned")).toBe(true);
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

// ---------------------------------------------------------------------------
// Review fixes: rung independence, streak/cooldown behavior, fail-closed
// enforcement, key-principal downgrade, session threading, status wiring.
// ---------------------------------------------------------------------------

describe("abuse review fixes", () => {
  test("warn rung never suppresses the revoke escalation", () => {
    const verdicts = drive(
      "user:u_ladder",
      "rate_limited",
      ABUSE_RATE_LIMIT_REVOKE_AT,
    );
    expect(verdicts[ABUSE_RATE_LIMIT_WARN_AT - 1]).toBe("warn");
    // Warn repeats cool down, but the revoke rung fires on its own cooldown.
    expect(verdicts.filter((v) => v === "warn").length).toBe(1);
    expect(verdicts.at(-1)).toBe("revoke");
  });

  test("validation and batch warns cool down, then re-fire past the window", () => {
    drive("user:u_vc", "validation_error", ABUSE_VALIDATION_WARN_AT);
    expect(
      noteAbuseOutcome({
        principal: "user:u_vc",
        outcome: "validation_error",
        nowMs: T0,
      }),
    ).toBe("ok");
    // Past the window the count restarts: a fresh full window warns again.
    expect(
      drive(
        "user:u_vc",
        "validation_error",
        ABUSE_VALIDATION_WARN_AT,
        T0 + 6 * MIN,
      ).at(-1),
    ).toBe("warn");
    drive("user:u_bc", "batch_rejected", ABUSE_BATCH_REJECT_WARN_AT);
    expect(
      noteAbuseOutcome({
        principal: "user:u_bc",
        outcome: "batch_rejected",
        nowMs: T0,
      }),
    ).toBe("ok");
    expect(
      drive(
        "user:u_bc",
        "batch_rejected",
        ABUSE_BATCH_REJECT_WARN_AT,
        T0 + 11 * MIN,
      ).at(-1),
    ).toBe("warn");
  });

  test("downgrade consumes its streak; anonymous quota warns once per cooldown", () => {
    const quotaAt = (principal: string, windowId: string, nowMs: number) =>
      noteAbuseOutcome({
        principal,
        outcome: "quota_exhausted",
        nowMs,
        quotaWindowId: windowId,
      });
    expect(quotaAt("user:u_dg", "w1", T0)).toBe("ok");
    expect(quotaAt("user:u_dg", "w2", T0)).toBe("ok");
    expect(quotaAt("user:u_dg", "w3", T0)).toBe("downgrade");
    // Past the cooldown one fresh empty is not enough (streak was
    // consumed by the downgrade — no fast walk down the ladder).
    const later = T0 + 16 * MIN;
    expect(quotaAt("user:u_dg", "w4", later)).toBe("ok");
    expect(quotaAt("user:u_dg", "w5", later)).toBe("ok");
    expect(quotaAt("user:u_dg", "w6", later)).toBe("downgrade");

    // Anonymous: warns once, then stays silent inside the cooldown even
    // under a shared-bucket flood (previously warned every window).
    clearAbuseState();
    expect(quotaAt("anonymous", "w1", T0)).toBe("ok");
    expect(quotaAt("anonymous", "w2", T0)).toBe("ok");
    expect(quotaAt("anonymous", "w3", T0)).toBe("warn");
    expect(quotaAt("anonymous", "w4", T0 + 1)).toBe("ok");
    expect(quotaAt("anonymous", "w5", T0 + 16 * MIN)).toBe("warn");
  });

  test("revoke strikes expire after a quiet day", () => {
    const revokeCycle = (at: number): string => {
      let verdict = "ok";
      for (let i = 0; i < ABUSE_AUTH_FAIL_REVOKE_AT; i += 1) {
        verdict = checkAbuse({
          principal: "user:u_stale",
          signal: "auth_failure",
          nowMs: at,
        });
      }
      return verdict;
    };
    expect(revokeCycle(T0)).toBe("revoke");
    // A quiet day wipes the strike: the next cycle revokes (strike 1),
    // it does not queue for a ban.
    const dayLater = T0 + 25 * 60 * MIN;
    expect(revokeCycle(dayLater)).toBe("revoke");
    // Two quick cycles inside the TTL escalate to ban-queued (strikes 2, 3).
    expect(revokeCycle(dayLater + 20 * MIN)).toBe("revoke");
    expect(revokeCycle(dayLater + 40 * MIN)).toBe("ban-queued");
  });

  test("Clerk 404 and backend failures fail closed without mutation", async () => {
    const missing = mockClerk("pro");
    missing.failGetUserStatus = 404;
    const gone = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_gone",
      requestId: "req-404",
      reason: "quota empty three windows running",
      clerk: missing,
      signal: AbortSignal.timeout(8000),
    });
    expect(gone.enforced).toBe(false);
    expect(missing.metadataUpdates).toEqual([]);

    const broken = mockClerk("pro");
    broken.failGetUserStatus = 500;
    const unavailable = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_broken",
      requestId: "req-503",
      reason: "quota empty three windows running",
      clerk: broken,
      signal: AbortSignal.timeout(8000),
    });
    expect(unavailable.enforced).toBe(false);
    expect(broken.metadataUpdates).toEqual([]);

    const revokeMissing = mockClerk("pro");
    revokeMissing.failGetUserStatus = 404;
    const noRevoke = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "user:u_gone",
      requestId: "req-404-r",
      reason: "credential spraying",
      sessionId: "sess_gone",
      clerk: revokeMissing,
      signal: AbortSignal.timeout(8000),
    });
    expect(noRevoke.enforced).toBe(false);
    expect(revokeMissing.revokedSessions).toEqual([]);
  });

  test("key-principal downgrade resolves the subject via targetUserId", async () => {
    const clerk = mockClerk("plus");
    const result = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "key:key_1",
      requestId: "req-k",
      reason: "quota empty three windows running",
      targetUserId: "user_subj",
      clerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(result.enforced).toBe(true);
    expect(clerk.getUserCalls).toEqual(["user_subj"]);
    expect(clerk.metadataUpdates).toEqual([
      { userId: "user_subj", tier: "free" },
    ]);
    const rows = abuseRows().filter((row) => row.action === "abuse.downgraded");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ oldTier: "plus", newTier: "free" });

    // Without a subject there is no attributable user — refuse, never guess.
    const noTarget = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "key:key_2",
      requestId: "req-k2",
      reason: "quota empty three windows running",
      clerk,
      signal: AbortSignal.timeout(8000),
    });
    expect(noTarget.enforced).toBe(false);
  });

  test("session id threads from the Clerk session into the auth context", () => {
    expect(
      contextFromClerkSession({ userId: "u_1", sessionId: "sess_9" }).sessionId,
    ).toBe("sess_9");
    expect(
      contextFromClerkSession({ userId: "u_1" }).sessionId,
    ).toBeUndefined();
    expect(
      contextFromClerkSession({ userId: "u_1", sessionId: 42 }).sessionId,
    ).toBeUndefined();
  });

  test("pipeline 400/401/504 responses feed counters without shape change", async () => {
    const increments: string[] = [];
    setObservabilityProvider({
      ...noopObservabilityProvider,
      increment: (name: string) => {
        increments.push(name);
      },
    });
    const statusRoute = (status: number, code: string) =>
      withRequestContext(
        async () =>
          errorResponse("pipe-status", {
            code,
            message: "shaped",
            hint: "fix and retry",
            status,
          }),
        {},
        "search",
      );
    const req = () => new NextRequest("http://x/api/v1/search?q=hi");
    // 400s count validation spam: 19 ok, 20th warns, shape unchanged.
    for (let i = 0; i < ABUSE_VALIDATION_WARN_AT - 1; i += 1) {
      expect((await statusRoute(400, "invalid_limit")(req())).status).toBe(400);
    }
    const warned = await statusRoute(400, "invalid_limit")(req());
    expect(warned.status).toBe(400);
    expect(
      ((await warned.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_limit");
    expect(increments).toContain("abuse.warned");
    // 401s count auth failures (5th warns on the shared anonymous bucket).
    const warnsBefore = abuseRows().filter(
      (row) => row.action === "abuse.warned",
    ).length;
    for (let i = 0; i < 5; i += 1) {
      expect((await statusRoute(401, "unauthenticated")(req())).status).toBe(
        401,
      );
    }
    expect(
      abuseRows().filter((row) => row.action === "abuse.warned").length,
    ).toBeGreaterThan(warnsBefore);
    // 504s count timeout churn (10th warns), still plain 504s.
    for (let i = 0; i < ABUSE_TIMEOUT_WARN_AT - 1; i += 1) {
      expect((await statusRoute(504, "upstream_timeout")(req())).status).toBe(
        504,
      );
    }
    expect((await statusRoute(504, "upstream_timeout")(req())).status).toBe(
      504,
    );
  });
});

// ---------------------------------------------------------------------------
// Round-1 review fixes: distinct-window quota counting, key-attributed
// abuse, awaited/bounded enforcement, 401-only auth failures, truthful
// non-enforcement audit, warn stamping.
// ---------------------------------------------------------------------------

describe("abuse round-1 fixes", () => {
  test("same-window quota retries never downgrade (explicit + implicit window)", () => {
    // Five rapid retries inside ONE exhausted window: a single observation.
    const same = ["w1", "w1", "w1", "w1", "w1"].map((quotaWindowId) =>
      noteAbuseOutcome({
        principal: "user:u_same",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId,
      }),
    );
    expect(same.every((v) => v === "ok")).toBe(true);
    // Implicit window (no id): the same calendar month dedupes the same way.
    expect(
      drive("user:u_same2", "quota_exhausted", 5).every((v) => v === "ok"),
    ).toBe(true);
    // Three DISTINCT windows still downgrade.
    expect(
      noteAbuseOutcome({
        principal: "user:u_same3",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w1",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_same3",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w2",
      }),
    ).toBe("ok");
    expect(
      noteAbuseOutcome({
        principal: "user:u_same3",
        outcome: "quota_exhausted",
        nowMs: T0,
        quotaWindowId: "w3",
      }),
    ).toBe("downgrade");
  });

  test("key-attributed pipeline abuse revokes the KEY, never owner sessions", async () => {
    const clerk = mockClerk("pro");
    const { client, revoked } = mockKeys();
    const run = withRequestContext(
      async () =>
        errorResponse("pipe-key", {
          code: "unauthenticated",
          message: "nope",
          hint: "sign in and retry",
          status: 401,
        }),
      {
        auth: {
          resolve: () => ({
            type: "api_key" as const,
            authenticated: true,
            keyId: "key_abuse1",
            userId: "owner_1",
          }),
        },
        abuseClerk: clerk,
        abuseKeys: client,
      },
      "search",
    );
    const req = () => new NextRequest("http://x/api/v1/search?q=hi");
    for (let i = 0; i < 5; i += 1) {
      expect((await run(req())).status).toBe(401);
    }
    // Enforcement was awaited before the 5th response returned, so the
    // revocation is synchronously visible here (no fire-and-forget race).
    expect(revoked.map((row) => row.apiKeyId)).toEqual(["key_abuse1"]);
    // The owner's sessions were never touched for key abuse.
    expect(clerk.revokedSessions).toEqual([]);
    // The audit row names the key, never the owner's user id.
    const revokedRows = abuseRows().filter(
      (row) => row.action === "abuse.revoked",
    );
    expect(revokedRows.length).toBe(1);
    expect(revokedRows[0]).toMatchObject({
      target: "key:key_abuse1",
      targetUserId: "key:key_abuse1",
    });
  });

  test("enforcement is bounded by the caller signal and never throws", async () => {
    const hanging: ClerkAdminClient = {
      async getUser(_userId: string, opts?: { signal?: AbortSignal }) {
        const signal = opts?.signal;
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        });
        throw new Error("aborted");
      },
      async updateUserMetadata(userId: string) {
        return { id: userId, publicMetadata: { tier: "pro" as const } };
      },
    };
    const start = Date.now();
    const result = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_hang",
      requestId: "req-hang",
      reason: "quota empty three windows running",
      clerk: hanging,
      signal: AbortSignal.timeout(50),
    });
    expect(result.enforced).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("403 scope/permission denials never count as auth failures", async () => {
    const statusRoute = (status: number, code: string) =>
      withRequestContext(
        async () =>
          errorResponse("pipe-403", {
            code,
            message: "denied",
            hint: "fix and retry",
            status,
          }),
        {},
        "search",
      );
    const req = () => new NextRequest("http://x/api/v1/search?q=hi");
    const rowsBefore = abuseRows().length;
    for (let i = 0; i < 10; i += 1) {
      expect((await statusRoute(403, "forbidden")(req())).status).toBe(403);
    }
    expect(abuseRows().length).toBe(rowsBefore);
    // Baseline 403s are ignored too: an authenticated non-admin denied by
    // the matrix (403, not 401) accrues no auth-failure signal.
    const guarded = withRequestContext(
      async () => {
        throw new Error("must not run when baseline denies");
      },
      {
        auth: {
          resolve: () => ({
            type: "user" as const,
            authenticated: true,
            userId: "user_plain",
          }),
        },
      },
      "search",
      { authorizationAction: "users:mutate-role" },
    );
    for (let i = 0; i < 6; i += 1) {
      expect((await guarded(req())).status).toBe(403);
    }
    expect(abuseRows().length).toBe(rowsBefore);
  });

  test("dry-run audits as warned, never revoked/downgraded", async () => {
    process.env.DRY_RUN = "1";
    const clerk = mockClerk("enterprise");
    const { client, revoked } = mockKeys();
    const keyResult = await enforceAbuseVerdict({
      verdict: "revoke",
      principal: "key:key_dry2",
      requestId: "req-dry-w",
      reason: "monitor mode",
      keys: client,
    });
    expect(keyResult).toEqual(
      expect.objectContaining({ enforced: false, dryRun: true }),
    );
    expect(revoked).toEqual([]);
    const tierResult = await enforceAbuseVerdict({
      verdict: "downgrade",
      principal: "user:u_dry2",
      requestId: "req-dry-w2",
      reason: "monitor mode",
      clerk,
    });
    expect(tierResult).toEqual(
      expect.objectContaining({ enforced: false, dryRun: true }),
    );
    const rows = abuseRows();
    expect(rows.some((row) => row.action === "abuse.revoked")).toBe(false);
    expect(rows.some((row) => row.action === "abuse.downgraded")).toBe(false);
    expect(rows.filter((row) => row.action === "abuse.warned").length).toBe(2);
  });

  test("validation-spam warn stamps Retry-After:60 + warnings[]", async () => {
    const run = withRequestContext(
      async () =>
        errorResponse("pipe-warn", {
          code: "invalid_limit",
          message: "bad",
          hint: "fix and retry",
          status: 400,
        }),
      {},
      "search",
    );
    const req = () => new NextRequest("http://x/api/v1/search?q=hi");
    for (let i = 0; i < ABUSE_VALIDATION_WARN_AT - 1; i += 1) {
      expect((await run(req())).status).toBe(400);
    }
    const warned = await run(req());
    expect(warned.status).toBe(400);
    expect(warned.headers.get("Retry-After")).toBe("60");
    const body = (await warned.json()) as {
      error: { code: string };
      warnings: Array<{ code: string }>;
    };
    expect(body.error.code).toBe("invalid_limit");
    expect(body.warnings[0]?.code).toBe("abuse_warned");
  });
});
