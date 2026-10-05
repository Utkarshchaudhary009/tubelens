// Phase 17 (Part B): abuse controls and anomaly detection.
//
// Conservative, reversible, per-principal controls built on the EXISTING
// rate-limit/quota/error signals — no new pipeline, no Redis, no Postgres
// ($0 Hobby: in-memory counters + stdout logs + audit rows; durable stores
// graduate only when abuse volume or multi-instance drift proves in-memory
// insufficient).
//
// Thresholds are verbatim from plans/PLAN.md Phase 17:
//
// | Signal                              | Threshold            | Auto action |
// | ----------------------------------- | -------------------- | ----------- |
// | 429 rate-limit hits                 | ≥10/10min → warn     | warn        |
// |                                     | ≥25/10min → revoke   | revoke      |
// | quota empty ×3 consecutive windows  | 3 windows → downgrade| downgrade   |
// | 400 validation spam                 | ≥20/5min → warn      | warn        |
// | batch rejects (oversize/cost)       | ≥5/10min → warn      | warn        |
// | invalid-token / auth failures       | ≥5/5min → revoke     | revoke      |
// | 8s-timeout churn                    | sustained → warn only| warn        |
//
// Rules:
// - Keying is on the rate-limit identity (`user:`/`key:`) — NEVER IP and
//   never a plaintext secret. Unattributable principals (the shared
//   `anonymous` bucket) are warn-only: they can never be revoked/downgraded
//   because one bad actor must not punish every anonymous caller.
// - `warn` changes no state: the caller already holds a normal 429 with
//   `Retry-After` + `X-RateLimit-*`; the control only logs, audits, and
//   emits a metric.
// - `revoke`/`downgrade` are enacted via the injectable Clerk seams
//   (`clerk-admin.ts`, `api-keys.ts`) inside the caller's 8s fail-fast
//   budget, with the reason in our own audit row (Clerk takes no reason
//   param — see the Phase 17 runbook). Authoritative `publicMetadata` is
//   re-fetched before every revoke/downgrade (session claims lag ~60s).
// - `ban-queued` never auto-executes: it writes an audit row and waits for
//   manual admin approval (Clerk Dashboard or the admin/users routes). There
//   is NO auto-ban endpoint and NO IP ban anywhere in this module.
// - Downgrade steps one tier down (`enterprise→pro→plus→free`) and never
//   below `free`.
// - `DRY_RUN=1` (week-1 monitor mode) logs + audits only: no revoke, no
//   downgrade, no ban execution.
// - Health, openapi.json, and admin traffic are exempt from counters.
// - Every entry point is best-effort and never throws: abuse controls must
//   never become a self-inflicted outage mechanism.
//
// Pure and server-only-safe: this module deliberately avoids
// `import "server-only"` (that package throws unconditionally under bun,
// which would make this module untestable — same rationale as
// `authorize.ts`/`clerk-auth.ts`/`rate-limit.ts`); the no-client guarantee
// comes from the import graph (API-only repo, Route Handlers only).

import { type ApiKeysClient, getApiKeysClient } from "./api-keys";
import { type AbuseAuditEvent, recordAuditEvent } from "./audit";
import {
  type ClerkAdminClient,
  clerkErrorStatus,
  getClerkAdminClient,
} from "./clerk-admin";
import { getObservabilityProvider } from "./observability";
import { KNOWN_TIERS, normalizeTier, type Tier } from "./product";
import { scrubString } from "./redact";

export type AbuseSignal =
  | "rate_limit_429"
  | "auth_failure"
  | "validation_400"
  | "batch_reject"
  | "timeout_churn"
  | "quota_empty";

export type AbuseVerdict =
  | "ok"
  | "warn"
  | "revoke"
  | "downgrade"
  | "ban-queued";

/** Pipeline/quota outcomes that feed the abuse counters (plus a reset). */
export type AbuseOutcome =
  | "rate_limited"
  | "auth_failure"
  | "validation_error"
  | "batch_rejected"
  | "timeout"
  | "quota_exhausted"
  /** A successful quota consume: clears the quota-empty streak. */
  | "quota_consumed";

// ---------------------------------------------------------------------------
// Thresholds (verbatim from plans/PLAN.md Phase 17; cooldowns 5–15min).
// ---------------------------------------------------------------------------

/** 429 rate-limit hits: ≥10/10min warn, ≥25/10min revoke, 10min cooldown. */
export const ABUSE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
export const ABUSE_RATE_LIMIT_WARN_AT = 10;
export const ABUSE_RATE_LIMIT_REVOKE_AT = 25;
export const ABUSE_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

/** Invalid-token / auth failures: ≥5/5min revoke, 15min cooldown. */
export const ABUSE_AUTH_FAIL_WINDOW_MS = 5 * 60_000;
export const ABUSE_AUTH_FAIL_REVOKE_AT = 5;
export const ABUSE_AUTH_FAIL_COOLDOWN_MS = 15 * 60_000;

/** 400 validation spam: ≥20/5min warn, 5min cooldown. */
export const ABUSE_VALIDATION_WINDOW_MS = 5 * 60_000;
export const ABUSE_VALIDATION_WARN_AT = 20;
export const ABUSE_VALIDATION_COOLDOWN_MS = 5 * 60_000;

/** Batch rejects (oversize/cost-overrun): ≥5/10min warn, 10min cooldown. */
export const ABUSE_BATCH_REJECT_WINDOW_MS = 10 * 60_000;
export const ABUSE_BATCH_REJECT_WARN_AT = 5;
export const ABUSE_BATCH_REJECT_COOLDOWN_MS = 10 * 60_000;

/**
 * 8s-timeout churn: sustained churn warns only, never revoke/ban (protects
 * legit slow-network users whose clients hammer retries). The "sustained"
 * bar is 10 churned timeouts in 10min with a 10min cooldown.
 */
export const ABUSE_TIMEOUT_WINDOW_MS = 10 * 60_000;
export const ABUSE_TIMEOUT_WARN_AT = 10;
export const ABUSE_TIMEOUT_COOLDOWN_MS = 10 * 60_000;

/**
 * Quota empty ×3 consecutive DISTINCT windows → downgrade one tier, 15min
 * cooldown. Repeats inside one exhausted window (same monthly window id)
 * are a SINGLE observation — N rapid 429s in one window never downgrade;
 * any successful consume resets the streak, and a downgrade consumes it
 * (the next rung needs three fresh windows).
 */
export const ABUSE_QUOTA_EMPTY_WINDOWS = 3;
export const ABUSE_DOWNGRADE_COOLDOWN_MS = 15 * 60_000;

/**
 * Ban queue: the 3rd revoke-level verdict for one principal stops
 * auto-enforcing and queues for manual admin approval instead.
 */
export const ABUSE_REVOKE_STRIKES_FOR_BAN_QUEUE = 3;

/**
 * Revoke-strike memory: strikes older than this stop counting toward the
 * ban queue (a principal quiet for a day starts clean — stale strikes must
 * never queue a reformed caller weeks later).
 */
export const ABUSE_REVOKE_STRIKE_TTL_MS = 24 * 60 * 60_000;

/** Fail-fast budget for every Clerk enforcement call (repo standard). */
export const ABUSE_ENFORCE_TIMEOUT_MS = 8000;

/** Bound for the process-local counter maps (warm servers must not grow forever). */
const MAX_ABUSE_KEYS = 5000;

/** Runtime bound matching the zod operator-reason schemas (≤280 chars). */
const MAX_REASON_CHARS = 280;

interface AbuseSignalPolicy {
  windowMs: number;
  warnAt?: number;
  revokeAt?: number;
  cooldownMs: number;
}

const SIGNAL_POLICIES: Record<
  Exclude<AbuseSignal, "quota_empty">,
  AbuseSignalPolicy
> = {
  rate_limit_429: {
    windowMs: ABUSE_RATE_LIMIT_WINDOW_MS,
    warnAt: ABUSE_RATE_LIMIT_WARN_AT,
    revokeAt: ABUSE_RATE_LIMIT_REVOKE_AT,
    cooldownMs: ABUSE_RATE_LIMIT_COOLDOWN_MS,
  },
  auth_failure: {
    windowMs: ABUSE_AUTH_FAIL_WINDOW_MS,
    revokeAt: ABUSE_AUTH_FAIL_REVOKE_AT,
    cooldownMs: ABUSE_AUTH_FAIL_COOLDOWN_MS,
  },
  validation_400: {
    windowMs: ABUSE_VALIDATION_WINDOW_MS,
    warnAt: ABUSE_VALIDATION_WARN_AT,
    cooldownMs: ABUSE_VALIDATION_COOLDOWN_MS,
  },
  batch_reject: {
    windowMs: ABUSE_BATCH_REJECT_WINDOW_MS,
    warnAt: ABUSE_BATCH_REJECT_WARN_AT,
    cooldownMs: ABUSE_BATCH_REJECT_COOLDOWN_MS,
  },
  timeout_churn: {
    windowMs: ABUSE_TIMEOUT_WINDOW_MS,
    warnAt: ABUSE_TIMEOUT_WARN_AT,
    cooldownMs: ABUSE_TIMEOUT_COOLDOWN_MS,
  },
};

const OUTCOME_TO_SIGNAL: Record<
  Exclude<AbuseOutcome, "quota_consumed">,
  AbuseSignal
> = {
  rate_limited: "rate_limit_429",
  auth_failure: "auth_failure",
  validation_error: "validation_400",
  batch_rejected: "batch_reject",
  timeout: "timeout_churn",
  quota_exhausted: "quota_empty",
};

const VERDICT_METRICS: Record<Exclude<AbuseVerdict, "ok">, string> = {
  warn: "abuse.warned",
  revoke: "abuse.revoked",
  downgrade: "abuse.downgraded",
  "ban-queued": "abuse.ban_queued",
};

// ---------------------------------------------------------------------------
// In-memory state (per-principal sliding windows + streaks).
// ---------------------------------------------------------------------------

interface AbuseCounter {
  count: number;
  windowStart: number;
  /**
   * Per-rung cooldowns: a warn firing must never suppress a later revoke
   * escalation inside the same window (the PLAN's two-rung ladder is
   * warn-at-10 THEN revoke-at-25) — each rung suppresses only its own
   * repeats.
   */
  lastWarnAt: number;
  lastRevokeAt: number;
}

interface QuotaEmptyStreak {
  count: number;
  lastDowngradeAt: number;
  /**
   * Last warn emitted for the shared anonymous bucket (attributable
   * principals downgrade instead of warning, so only anonymous uses this).
   */
  lastAnonymousWarnAt: number;
  /**
   * Monthly window id of the last COUNTED empty observation (`YYYY-MM`,
   * matching `quotaWindowFor`). Repeats inside the same window are ignored
   * (one increment per window per principal) — without this, retries in a
   * single exhausted window would wrongful-downgrade.
   */
  lastWindowId?: string;
}

const counters = new Map<string, AbuseCounter>();
const quotaEmptyStreaks = new Map<string, QuotaEmptyStreak>();
interface RevokeStrikes {
  count: number;
  /** Timestamp of the latest strike (tests override via nowMs). */
  at: number;
}
const revokeStrikes = new Map<string, RevokeStrikes>();

/** Clear all abuse state (primarily for tests). */
export function clearAbuseState(): void {
  counters.clear();
  quotaEmptyStreaks.clear();
  revokeStrikes.clear();
}

/** Bounded put: evict the oldest key when a genuinely new key overflows. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_ABUSE_KEYS && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

// ---------------------------------------------------------------------------
// Principal + route gating.
// ---------------------------------------------------------------------------

/**
 * True only for attributable principals. Anonymous callers share one
 * bucket that many strangers draw from, so it is warn-only by construction
 * (one bad actor must never revoke or downgrade strangers). Keying is on
 * the rate-limit identity string — IP addresses are never read here.
 */
export function isAttributablePrincipal(principal: string): boolean {
  return principal.startsWith("user:") || principal.startsWith("key:");
}

/**
 * Routes exempt from abuse counters: liveness, the public spec, and admin
 * traffic (audited operator writes, not abuse signals).
 */
export function isAbuseExemptRoute(route: string | undefined): boolean {
  if (route === undefined || route === "") {
    return false;
  }
  return (
    route === "health" || route === "openapi" || route.startsWith("admin.")
  );
}

/** Week-1 monitor mode: log + audit only, never revoke/downgrade. */
export function isAbuseDryRun(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.DRY_RUN ?? "").trim() === "1";
}

/** Step one tier down the ranked ladder; never below `free`. */
export function downgradeTier(tier: Tier): Tier {
  const rank = KNOWN_TIERS.indexOf(tier);
  if (rank <= 0) {
    return "free";
  }
  return KNOWN_TIERS[rank - 1] ?? "free";
}

// ---------------------------------------------------------------------------
// Observation: count one signal, return the verdict.
// ---------------------------------------------------------------------------

export interface AbuseCheckInput {
  /** Rate-limit identity (`user:…` / `key:…` / `anonymous`) — never IP. */
  principal: string;
  signal: AbuseSignal;
  /** Pipeline route label; exempt routes are not counted. */
  route?: string;
  requestId?: string;
  /** Clerk user id override (key principals whose subject is known). */
  targetUserId?: string;
  /**
   * Distinct-window discriminator for `quota_empty` (the monthly
   * `quotaCheck.windowId`, `YYYY-MM`). Repeats carrying the same window id
   * as the last counted observation are ignored. Omit only in tests — the
   * fallback is the calendar month of `nowMs`, which matches
   * `quotaWindowFor` exactly.
   */
  quotaWindowId?: string;
  /** Clock override (tests); defaults to Date.now. */
  nowMs?: number;
}

/**
 * Count one abuse signal for a principal and return the verdict. Pure
 * counting: `warn` changes no state (the caller already holds a normal 429
 * with `Retry-After` + `X-RateLimit-*`); `revoke`/`downgrade` still require
 * `enforceAbuseVerdict`; `ban-queued` only writes its audit row here and
 * waits for manual approval. Never throws — counting must never break a
 * response.
 */
export function checkAbuse(input: AbuseCheckInput): AbuseVerdict {
  try {
    return evaluateAbuse(input);
  } catch {
    return "ok";
  }
}

/**
 * Count one pipeline/quota outcome (the only new-pipeline glue this phase
 * adds: routes keep calling the rate-limit/quota stages exactly as before,
 * and those stages forward their ALREADY-COMPUTED outcomes here). Returns
 * the same verdict `checkAbuse` would. Never throws.
 */
export function noteAbuseOutcome(input: {
  principal: string;
  route?: string;
  outcome: AbuseOutcome;
  requestId?: string;
  targetUserId?: string;
  /** Distinct-window discriminator for `quota_exhausted` (see above). */
  quotaWindowId?: string;
  nowMs?: number;
}): AbuseVerdict {
  try {
    if (input.outcome === "quota_consumed") {
      resetAbuseQuotaStreak(input.principal);
      return "ok";
    }
    return checkAbuse({
      principal: input.principal,
      signal: OUTCOME_TO_SIGNAL[input.outcome],
      route: input.route,
      requestId: input.requestId,
      targetUserId: input.targetUserId,
      ...(input.quotaWindowId !== undefined
        ? { quotaWindowId: input.quotaWindowId }
        : {}),
      nowMs: input.nowMs,
    });
  } catch {
    return "ok";
  }
}

/** Clear one principal's quota-empty streak (a consume proves allowance remains). */
export function resetAbuseQuotaStreak(principal: string): void {
  try {
    const streak = quotaEmptyStreaks.get(principal);
    if (streak && streak.count !== 0) {
      rememberQuotaStreak(principal, { ...streak, count: 0 });
    }
  } catch {
    // Intentionally ignored — telemetry must never break a response.
  }
}

function rememberQuotaStreak(
  principal: string,
  streak: QuotaEmptyStreak,
): void {
  remember(quotaEmptyStreaks, principal, streak);
}

/** Calendar-month bucket (`YYYY-MM`) — identical to `quotaWindowFor`. */
function monthBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function evaluateAbuse(input: AbuseCheckInput): AbuseVerdict {
  const now = input.nowMs ?? Date.now();
  if (isAbuseExemptRoute(input.route)) {
    return "ok";
  }
  if (input.signal === "quota_empty") {
    return evaluateQuotaEmpty(input, now);
  }
  const policy = SIGNAL_POLICIES[input.signal];
  const key = `${input.principal}::${input.signal}`;
  let bucket = counters.get(key);
  if (!bucket || now - bucket.windowStart >= policy.windowMs) {
    bucket = {
      count: 0,
      windowStart: now,
      lastWarnAt: bucket?.lastWarnAt ?? 0,
      lastRevokeAt: bucket?.lastRevokeAt ?? 0,
    };
  }
  bucket.count += 1;
  remember(counters, key, bucket);

  let verdict: AbuseVerdict = "ok";
  if (policy.revokeAt !== undefined && bucket.count >= policy.revokeAt) {
    verdict = "revoke";
  } else if (policy.warnAt !== undefined && bucket.count >= policy.warnAt) {
    verdict = "warn";
  }
  if (verdict === "ok") {
    return "ok";
  }
  // Anonymous shared bucket is warn-only: unattributable, never
  // revoke/downgrade (one bad actor must not punish strangers).
  if (!isAttributablePrincipal(input.principal)) {
    verdict = "warn";
  }
  // Cooldown per rung: a warn firing must never suppress a later revoke
  // escalation in the same window (the two-rung ladder is warn-at-10 THEN
  // revoke-at-25) — each rung suppresses only its own repeats while the
  // window keeps sliding underneath.
  if (verdict === "revoke") {
    if (now - bucket.lastRevokeAt < policy.cooldownMs) {
      return "ok";
    }
    bucket.lastRevokeAt = now;
  } else {
    if (now - bucket.lastWarnAt < policy.cooldownMs) {
      return "ok";
    }
    bucket.lastWarnAt = now;
  }
  if (verdict === "revoke") {
    const prior = revokeStrikes.get(input.principal);
    const fresh =
      prior !== undefined && now - prior.at < ABUSE_REVOKE_STRIKE_TTL_MS
        ? prior.count
        : 0;
    const strikes = fresh + 1;
    if (strikes >= ABUSE_REVOKE_STRIKES_FOR_BAN_QUEUE) {
      // Third strike: stop auto-enforcing, queue for a human instead.
      remember(revokeStrikes, input.principal, { count: 0, at: now });
      verdict = "ban-queued";
    } else {
      remember(revokeStrikes, input.principal, { count: strikes, at: now });
    }
  }
  emitAbuseMetric(verdict);
  if (verdict === "warn") {
    auditAbuse(
      "abuse.warned",
      input,
      now,
      abuseReason(input.signal, bucket.count, policy),
    );
  } else if (verdict === "ban-queued") {
    auditAbuse(
      "abuse.ban_queued",
      input,
      now,
      "Repeated revoke-level abuse; queued for manual admin approval — never auto-banned.",
    );
  }
  // `revoke`/`downgrade` verdicts audit at enforcement time (per mutation,
  // with the outcome), not here — see `enforceAbuseVerdict`.
  return verdict;
}

function evaluateQuotaEmpty(input: AbuseCheckInput, now: number): AbuseVerdict {
  // Distinct-window counting: retries inside one exhausted monthly window
  // are ONE observation. The fallback derives the calendar month from the
  // clock (identical to `quotaWindowFor`), so callers that omit the window
  // still dedupe same-window retries.
  const windowId = input.quotaWindowId ?? monthBucket(now);
  const prior = quotaEmptyStreaks.get(input.principal);
  if (prior?.lastWindowId === windowId) {
    return "ok";
  }
  const streak: QuotaEmptyStreak = {
    count: (prior?.count ?? 0) + 1,
    lastDowngradeAt: prior?.lastDowngradeAt ?? 0,
    lastAnonymousWarnAt: prior?.lastAnonymousWarnAt ?? 0,
    lastWindowId: windowId,
  };
  rememberQuotaStreak(input.principal, streak);
  if (streak.count < ABUSE_QUOTA_EMPTY_WINDOWS) {
    return "ok";
  }
  if (!isAttributablePrincipal(input.principal)) {
    // Shared-bucket flood guard: one warn per cooldown, not one per
    // exhausted window — every extra warn is metric/audit spam.
    if (now - streak.lastAnonymousWarnAt < ABUSE_DOWNGRADE_COOLDOWN_MS) {
      return "ok";
    }
    streak.lastAnonymousWarnAt = now;
    emitAbuseMetric("warn");
    auditAbuse(
      "abuse.warned",
      input,
      now,
      "Quota exhausted repeatedly on the shared anonymous bucket; warn-only, never downgraded.",
    );
    return "warn";
  }
  if (now - streak.lastDowngradeAt < ABUSE_DOWNGRADE_COOLDOWN_MS) {
    return "ok";
  }
  streak.lastDowngradeAt = now;
  // A downgrade consumes the streak: the next rung needs three FRESH
  // consecutive empty windows, so one long drought cannot fast-walk a
  // caller down the tier ladder on a single observation run.
  streak.count = 0;
  emitAbuseMetric("downgrade");
  return "downgrade";
}

function abuseReason(
  signal: AbuseSignal,
  count: number,
  policy: AbuseSignalPolicy,
): string {
  const windowMin = Math.round(policy.windowMs / 60_000);
  switch (signal) {
    case "rate_limit_429":
      return (
        `Rate-limit hits reached ${count} in ${windowMin}min; ` +
        "slow down and retry after the time in Retry-After."
      );
    case "auth_failure":
      return (
        `Authentication failures reached ${count} in ${windowMin}min; ` +
        "verify credentials before retrying."
      );
    case "validation_400":
      return (
        `Rejected requests reached ${count} in ${windowMin}min; ` +
        "fix the request shape before retrying."
      );
    case "batch_reject":
      return (
        `Rejected batch calls reached ${count} in ${windowMin}min; ` +
        "shrink batch size and cost before retrying."
      );
    case "timeout_churn":
      return (
        `Upstream timeout retries reached ${count} in ${windowMin}min; ` +
        "back off and retry later — this signal never revokes."
      );
    case "quota_empty":
      return "Monthly credit allowance exhausted repeatedly; reduce usage or wait for reset.";
  }
}

// ---------------------------------------------------------------------------
// Telemetry + audit (sanitized by construction: ids and counts only).
// ---------------------------------------------------------------------------

function emitAbuseMetric(verdict: AbuseVerdict): void {
  if (verdict === "ok") {
    return;
  }
  try {
    getObservabilityProvider().increment(VERDICT_METRICS[verdict]);
  } catch {
    // Intentionally ignored — telemetry must never break a response.
  }
}

function deriveAbuseTarget(principal: string, override?: string): string {
  if (override !== undefined && override !== "") {
    return override;
  }
  if (principal.startsWith("user:")) {
    const id = principal.slice("user:".length);
    return id === "" ? principal : id;
  }
  return principal;
}

/**
 * Minimal identity surface both `AbuseCheckInput` and `AbuseEnforceInput`
 * satisfy (their `signal` fields differ, so neither is assignable to the
 * other — this structural slice is).
 */
interface AbuseAuditIdentity {
  principal: string;
  requestId?: string;
  targetUserId?: string;
}

function auditAbuse(
  action: AbuseAuditEvent["action"],
  input: AbuseAuditIdentity,
  now: number,
  reason: string,
  extra?: { oldTier?: Tier; newTier?: Tier },
): void {
  try {
    const target = deriveAbuseTarget(input.principal, input.targetUserId);
    recordAuditEvent({
      action,
      actor: "system",
      target,
      targetUserId: target,
      ts: new Date(now).toISOString(),
      requestId: input.requestId ?? "unknown",
      reason,
      ...(extra?.oldTier !== undefined ? { oldTier: extra.oldTier } : {}),
      ...(extra?.newTier !== undefined ? { newTier: extra.newTier } : {}),
    });
  } catch {
    // Intentionally ignored — audit must never break enforcement.
  }
}

// ---------------------------------------------------------------------------
// Enforcement: carry out a revoke/downgrade verdict (or deliberately not).
// ---------------------------------------------------------------------------

export interface AbuseEnforceInput {
  verdict: AbuseVerdict;
  /** Rate-limit identity the verdict was computed for. */
  principal: string;
  requestId: string;
  /** Operator-readable reason (≤280 chars, scrubbed before audit). */
  reason: string;
  /** Session to revoke for `user:` principals (omit when unknown). */
  sessionId?: string;
  /** Clerk user id override (key principals whose subject is known). */
  targetUserId?: string;
  clerk?: ClerkAdminClient;
  keys?: ApiKeysClient;
  env?: Record<string, string | undefined>;
  /** Fail-fast signal; callers pass `AbortSignal.timeout(8000)`. */
  signal?: AbortSignal;
}

export interface AbuseEnforceResult {
  enforced: boolean;
  dryRun: boolean;
  detail: string;
}

/**
 * Enforce a `checkAbuse` verdict. `ok`/`warn`/`ban-queued` never mutate:
 * warn needs no action and bans require manual approval. `revoke`
 * revokes one session (`user:` + sessionId) or one API key (`key:`);
 * `downgrade` re-fetches authoritative metadata and steps the tier down
 * one rung (never below `free`). Every mutation writes its own audit row
 * with the reason (Clerk takes no reason param). `DRY_RUN=1` logs + audits
 * only. Never throws — callers get `{ enforced: false, detail }` instead.
 */
export async function enforceAbuseVerdict(
  input: AbuseEnforceInput,
): Promise<AbuseEnforceResult> {
  try {
    return await enforce(input);
  } catch (err) {
    return {
      enforced: false,
      dryRun: false,
      detail: failureDetail(err),
    };
  }
}

async function enforce(input: AbuseEnforceInput): Promise<AbuseEnforceResult> {
  if (input.verdict === "ok" || input.verdict === "warn") {
    return {
      enforced: false,
      dryRun: false,
      detail: `No enforcement for verdict "${input.verdict}".`,
    };
  }
  if (input.verdict === "ban-queued") {
    return {
      enforced: false,
      dryRun: false,
      detail: "Ban requires manual admin approval; audit row queued.",
    };
  }
  const reason = cleanReason(input.reason);
  if (isAbuseDryRun(input.env ?? process.env)) {
    // Week-1 monitor mode: structured log + audit row, zero mutations. The
    // audit action is truthfully `abuse.warned` (NOT revoked/downgraded —
    // nothing was enforced); the reason names the attempted verdict.
    console.info(
      JSON.stringify({
        level: "abuse",
        dryRun: true,
        verdict: input.verdict,
        principal: input.principal,
        requestId: input.requestId,
        reason: scrubString(reason),
      }),
    );
    auditAbuse(
      "abuse.warned",
      {
        principal: input.principal,
        requestId: input.requestId,
        targetUserId: input.targetUserId,
      },
      Date.now(),
      `DRY_RUN=1 — would have enforced ${input.verdict}; no state changed.`,
    );
    return {
      enforced: false,
      dryRun: true,
      detail: "DRY_RUN=1 set; enforcement skipped.",
    };
  }
  return input.verdict === "revoke"
    ? enforceRevoke(input, reason)
    : enforceDowngrade(input, reason);
}

async function enforceRevoke(
  input: AbuseEnforceInput,
  reason: string,
): Promise<AbuseEnforceResult> {
  const signal = input.signal ?? AbortSignal.timeout(ABUSE_ENFORCE_TIMEOUT_MS);
  if (input.principal.startsWith("key:")) {
    const keyId = input.principal.slice("key:".length);
    if (keyId === "") {
      return {
        enforced: false,
        dryRun: false,
        detail: "Cannot revoke: principal carries no key reference.",
      };
    }
    const keys = input.keys ?? getApiKeysClient();
    await keys.revokeKey(
      {
        apiKeyId: keyId,
        ...(reason === "" ? {} : { revocationReason: reason }),
      },
      { signal },
    );
    // The plaintext secret never appears here: only the key reference and
    // the operator reason reach the audit row.
    auditAbuse("abuse.revoked", input, Date.now(), reason);
    return { enforced: true, dryRun: false, detail: "API key revoked." };
  }
  if (input.principal.startsWith("user:")) {
    const userId = deriveAbuseTarget(input.principal, input.targetUserId);
    if (!input.sessionId) {
      // No session handle: revoking "the user" wholesale would be a blunt
      // instrument, so record the decision truthfully as a warn (NOT
      // revoked — nothing was enforced) and leave the session to an
      // operator (Dashboard or admin/users routes).
      auditAbuse(
        "abuse.warned",
        input,
        Date.now(),
        `${reason} Revoke deferred: no session id — operator must revoke via the Clerk Dashboard.`,
      );
      return {
        enforced: false,
        dryRun: false,
        detail: "No session id; revocation left to an operator.",
      };
    }
    const clerk = input.clerk ?? getClerkAdminClient();
    // Freshness rule (60s claim lag): confirm the user still exists before
    // touching sessions — a deleted user has nothing to revoke, and any
    // other backend failure fails closed (no blind mutation).
    try {
      await clerk.getUser(userId, { signal });
    } catch (err) {
      if (clerkErrorStatus(err) === 404) {
        return {
          enforced: false,
          dryRun: false,
          detail: "Target user no longer exists; nothing to revoke.",
        };
      }
      return {
        enforced: false,
        dryRun: false,
        detail: "User directory unavailable; revocation not attempted.",
      };
    }
    if (!clerk.revokeSession) {
      return {
        enforced: false,
        dryRun: false,
        detail: "Client cannot revoke sessions; revocation not attempted.",
      };
    }
    await clerk.revokeSession(input.sessionId, { signal });
    auditAbuse("abuse.revoked", input, Date.now(), reason);
    return { enforced: true, dryRun: false, detail: "Session revoked." };
  }
  // Unattributable (anonymous bucket) — warn-only by construction; a
  // revoke verdict cannot reach here via checkAbuse, this is defense.
  return {
    enforced: false,
    dryRun: false,
    detail: "Anonymous bucket is warn-only; never revoked.",
  };
}

async function enforceDowngrade(
  input: AbuseEnforceInput,
  reason: string,
): Promise<AbuseEnforceResult> {
  const targetUserId = input.principal.startsWith("user:")
    ? deriveAbuseTarget(input.principal, input.targetUserId)
    : (input.targetUserId ?? "");
  if (targetUserId === "" || targetUserId === "anonymous") {
    return {
      enforced: false,
      dryRun: false,
      detail: "Downgrade needs an attributable user; anonymous is warn-only.",
    };
  }
  const signal = input.signal ?? AbortSignal.timeout(ABUSE_ENFORCE_TIMEOUT_MS);
  const clerk = input.clerk ?? getClerkAdminClient();
  // Freshness rule (60s claim lag): step down from AUTHORITATIVE metadata,
  // never from the request's projected claim.
  let oldTier: Tier;
  try {
    const record = await clerk.getUser(targetUserId, { signal });
    oldTier = normalizeTier(record.publicMetadata?.tier);
  } catch (err) {
    if (clerkErrorStatus(err) === 404) {
      return {
        enforced: false,
        dryRun: false,
        detail: "Target user no longer exists; nothing to downgrade.",
      };
    }
    return {
      enforced: false,
      dryRun: false,
      detail: "User directory unavailable; downgrade not attempted.",
    };
  }
  const newTier = downgradeTier(oldTier);
  if (newTier === oldTier) {
    // Already at `free` — there is no lower rung, so no mutation.
    return {
      enforced: false,
      dryRun: false,
      detail: "Already at free; never downgraded below free.",
    };
  }
  await clerk.updateUserMetadata(
    targetUserId,
    { publicMetadata: { tier: newTier } },
    { signal },
  );
  auditAbuse("abuse.downgraded", input, Date.now(), reason, {
    oldTier,
    newTier,
  });
  return {
    enforced: true,
    dryRun: false,
    detail: `Tier stepped down from ${oldTier} to ${newTier}.`,
  };
}

function cleanReason(reason: string): string {
  const trimmed = (typeof reason === "string" ? reason : "").trim();
  const scrubbed = scrubString(trimmed);
  return scrubbed.length > MAX_REASON_CHARS
    ? scrubbed.slice(0, MAX_REASON_CHARS)
    : scrubbed;
}

function failureDetail(err: unknown): string {
  if (err instanceof Error && err.message !== "") {
    return scrubString(err.message).slice(0, MAX_REASON_CHARS);
  }
  return "Enforcement failed without detail.";
}
