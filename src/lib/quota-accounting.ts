// Phase 14 (Part B): monthly weighted-credit quota accounting.
//
// Answers PLANS_AND_USAGE.md section 7's quota question — "how much of this
// plan's allowance has this principal consumed during the current period?" —
// with a deterministic monthly UTC-calendar window per identity. The
// pipeline's quota stage calls `checkAndConsume` BEFORE the handler; the
// post-response `usageRecord` ledger writer (usage.ts) carries the same
// window fields.
//
// Separation (Phase 15 owns the enforcement): this module never rate-limits
// (Redis answers "can I request now?") and never caches (CDN/in-memory
// answers "can an upstream fetch be avoided?"). It only tracks allowance.
//
// Tier allowances: the ONLY deterministic number in PLANS_AND_USAGE.md
// section 8 is Free: 10,000 monthly credits. plus/pro/enterprise have no
// defined numbers, so they conservatively fall back to the free allowance
// until that document defines them — do NOT invent competing tier numbers.
//
// Pure and server-only-safe: this module deliberately avoids
// `import "server-only"` (that package throws unconditionally under bun,
// which would make this module untestable — same rationale as
// `quota.ts`/`rate-limit.ts`); the no-client guarantee comes from the import
// graph (API-only repo, Route Handlers only). The durable Postgres writer
// lives in `./quota-ledger` behind an injected seam so tests use stub
// doubles and never touch a live database.

import type { AuthContext } from "./auth";
import type { Tier } from "./product";
import { QUOTA_POLICY_VERSION } from "./quota";

/**
 * Monthly weighted-credit allowance per tier. Only `free` is deterministic
 * per PLANS_AND_USAGE.md section 8 (10,000); every other ranked tier falls
 * back to it via `allowanceForTier` until that document defines real
 * numbers.
 */
export const TIER_ALLOWANCES = { free: 10_000 } as const;

/**
 * Monthly allowance for a tier. Known tiers without a defined allowance
 * (plus/pro/enterprise — reserved, no numbers in PLANS_AND_USAGE.md
 * section 8) conservatively receive the free allowance: never more, never
 * invented.
 */
export function allowanceForTier(tier: Tier): number {
  const table: Record<string, number> = { ...TIER_ALLOWANCES };
  return table[tier] ?? TIER_ALLOWANCES.free;
}

// ---------------------------------------------------------------------------
// Monthly UTC-calendar windows.
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  /** Calendar month id, e.g. "2026-09". */
  windowId: string;
  /** Epoch ms of the next UTC month boundary (when this window resets). */
  resetMs: number;
}

/**
 * Resolve the monthly window containing `nowMs`. Pure and clock-injectable:
 * pass a mocked `nowMs` to test month-boundary rollover deterministically.
 */
export function quotaWindowFor(nowMs: number): QuotaWindow {
  if (!Number.isFinite(nowMs)) {
    throw new Error("Quota clock must be finite epoch milliseconds.");
  }
  const at = new Date(nowMs);
  const year = at.getUTCFullYear();
  const monthIndex = at.getUTCMonth();
  const month = monthIndex + 1;
  return {
    windowId: `${year}-${String(month).padStart(2, "0")}`,
    resetMs: Date.UTC(year, monthIndex + 1, 1),
  };
}

// ---------------------------------------------------------------------------
// Store seam: fast counters now, durable ledger when enabled.
// ---------------------------------------------------------------------------

/** Extra row fields the durable ledger needs beyond identity/window/cost. */
export interface QuotaChargeDetails {
  operation: string;
  policyVersion: string;
  tier: string;
  requestId: string;
}

export interface QuotaStore {
  /** Credits already consumed by `identity` in `windowId` (0 when none). */
  get(identity: string, windowId: string): number | Promise<number>;
  /**
   * Consume `cost` credits, returning the new consumed total. Durable
   * implementations persist an `accepted` ledger row (using `details` when
   * provided); the in-memory default just bumps its counter.
   */
  add(
    identity: string,
    windowId: string,
    cost: number,
    details?: QuotaChargeDetails,
  ): number | Promise<number>;
}

const KEY_SEPARATOR = ":";
const MAX_IDENTITY_LENGTH = 256;

function storeKey(identity: string, windowId: string): string {
  return `${identity}${KEY_SEPARATOR}${windowId}`;
}

/** Default store: per-process counters. Lost on restart/redeploy by design. */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly used = new Map<string, number>();
  /**
   * Idempotency keys seen per bucket — mirrors the Postgres UNIQUE(request_id)
   * so a retried consume with the same request id is a no-op in both stores.
   * Keyless adds (no request id) always charge: without a key there is
   * nothing to dedupe on.
   */
  private readonly seen = new Set<string>();

  get(identity: string, windowId: string): number {
    requireIdentity(identity);
    return this.used.get(storeKey(identity, windowId)) ?? 0;
  }

  add(
    identity: string,
    windowId: string,
    cost: number,
    details?: QuotaChargeDetails,
  ): number {
    requireIdentity(identity);
    const key = storeKey(identity, windowId);
    const requestId = details?.requestId;
    if (typeof requestId === "string" && requestId !== "") {
      const seenKey = `${key}${KEY_SEPARATOR}${requestId}`;
      if (this.seen.has(seenKey)) {
        return this.used.get(key) ?? 0;
      }
      this.seen.add(seenKey);
    }
    const next = (this.used.get(key) ?? 0) + cost;
    this.used.set(key, next);
    return next;
  }

  /** Test/deploy helper: drop all counters. */
  clear(): void {
    this.used.clear();
    this.seen.clear();
  }
}

function requireIdentity(identity: string): void {
  if (
    typeof identity !== "string" ||
    identity.trim() === "" ||
    identity.length > MAX_IDENTITY_LENGTH
  ) {
    // Static message — never echo the raw value (it may be attacker input).
    throw new Error("Quota identity is missing.");
  }
}

/**
 * The accountable quota principal for a request — the single choke point
 * used for BOTH the store key and the ledger row principal, so the two can
 * never drift apart.
 *
 * It IS the rate-limit identity string by construction (`user:…` /
 * `key:…` / `anonymous`): quota dimensions match limiter dimensions, and
 * `auth` is carried so future per-dimension splits (project/org) extend
 * HERE, not at call sites.
 *
 * Anonymous policy: all anonymous callers SHARE the single `anonymous`
 * bucket. `X-Forwarded-For` is attacker-rotatable (see
 * `request-context.ts`), so per-IP anonymous buckets would let one caller
 * mint unlimited quota buckets — the shared bucket is the same tradeoff
 * the rate limiter makes. Authenticate for a personal allowance.
 */
export function quotaPrincipal(ctx: {
  auth: AuthContext;
  rateLimitIdentity: string;
}): string {
  void ctx.auth;
  return ctx.rateLimitIdentity;
}

// ---------------------------------------------------------------------------
// Engine: check the allowance, consume on allow, never consume on deny.
// ---------------------------------------------------------------------------

export interface QuotaConsumeInput {
  /** Accountable identity, e.g. "user:user_123" — never a plaintext secret. */
  identity: string;
  tier: Tier;
  /** Weighted-credit cost from the quota.ts catalog (fail closed upstream). */
  cost: number;
  operation: string;
  policyVersion?: string;
  /** Clock override (tests); defaults to Date.now. */
  nowMs?: number;
  /** Request id stamped on durable rows (no secrets — ids only). */
  requestId?: string;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Credits consumed in this window AFTER this decision (unchanged on deny). */
  used: number;
  remaining: number;
  allowance: number;
  windowId: string;
  resetMs: number;
  operation: string;
  policyVersion: string;
  tier: Tier;
}

/** Read-only allowance probe — everything `checkAndConsume` needs to know. */
export interface QuotaCheckInput {
  identity: string;
  tier: Tier;
  cost: number;
  nowMs?: number;
}

export interface QuotaCheck {
  allowed: boolean;
  /** Credits consumed so far (unchanged — a check never writes). */
  used: number;
  remaining: number;
  allowance: number;
  windowId: string;
  resetMs: number;
}

/**
 * Probe `identity`'s monthly allowance WITHOUT consuming. The pipeline
 * peeks pre-handler (rejects 429 before any upstream work) and records
 * consumption only after the handler produces a response — so a handler
 * throw (our crash, no response) is never charged, while an admitted
 * attempt that consumed upstream work is charged even when it fails.
 */
export async function checkAllowance(
  store: QuotaStore,
  input: QuotaCheckInput,
): Promise<QuotaCheck> {
  requireIdentity(input.identity);
  const cost = requireCost(input.cost);
  const allowance = allowanceForTier(input.tier);
  const { windowId, resetMs } = quotaWindowFor(input.nowMs ?? Date.now());
  const used = requireBalance(await store.get(input.identity, windowId));
  return {
    allowed: used + cost <= allowance,
    used,
    remaining: Math.max(0, allowance - used),
    allowance,
    windowId,
    resetMs,
  };
}

export interface QuotaConsumption {
  identity: string;
  tier: Tier;
  windowId: string;
  cost: number;
  operation: string;
  policyVersion: string;
  requestId?: string;
}

/**
 * Ledger idempotency key: the caller's request id when present, otherwise a
 * minted UUID. Never `""` — the durable ledger holds UNIQUE(request_id), so
 * a shared empty key would silently drop every id-less charge after the
 * first. Callers that echo a caller-supplied X-Request-Id share one key by
 * construction (retries safe; see the quota-ledger.ts caveat).
 */
export function idempotencyKey(requestId?: string): string {
  return typeof requestId === "string" && requestId !== ""
    ? requestId
    : crypto.randomUUID();
}

/**
 * Record one admitted attempt's consumption, returning the new total.
 * Call ONLY after the handler produces a response (success or error):
 * attempt-based charging — admitted work is charged even when upstream
 * fails; quota rejections and handler throws never reach here.
 */
export async function recordConsumption(
  store: QuotaStore,
  input: QuotaConsumption,
): Promise<{ used: number; windowId: string }> {
  requireIdentity(input.identity);
  const cost = requireCost(input.cost);
  // requestId is the ledger idempotency key (UNIQUE + ON CONFLICT DO
  // NOTHING): admitted attempts retry safely, and a future durable
  // usage.record(accepted) with the same id can never double-charge.
  const requestId = idempotencyKey(input.requestId);
  const used = requireBalance(
    await store.add(input.identity, input.windowId, cost, {
      operation: input.operation,
      policyVersion: input.policyVersion,
      tier: input.tier,
      requestId,
    }),
  );
  return { used, windowId: input.windowId };
}

function requireCost(cost: number): number {
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    throw new Error("Quota cost must be a finite number.");
  }
  const weight = Math.floor(cost);
  if (weight < 1) {
    throw new Error("Quota cost must be at least 1.");
  }
  return weight;
}

function requireBalance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Quota store returned an invalid balance.");
  }
  return Math.floor(value);
}

/**
 * Check `identity`'s monthly allowance and consume `cost` when it fits.
 * Denial consumes nothing (the caller records a `rejected` usage event
 * without touching the store). A corrupt store balance fails closed.
 *
 * Charging policy (attempt-based, no refunds): an admitted attempt is
 * charged even when upstream work fails — only quota rejections skip
 * consumption. The pipeline refines this one step further by peeking
 * pre-handler and consuming post-response, so a handler throw (our crash,
 * no response produced) is never charged either.
 */
export async function checkAndConsume(
  store: QuotaStore,
  input: QuotaConsumeInput,
): Promise<QuotaDecision> {
  requireIdentity(input.identity);
  const cost = requireCost(input.cost);
  const allowance = allowanceForTier(input.tier);
  const policyVersion = input.policyVersion ?? QUOTA_POLICY_VERSION;
  const checked = await checkAllowance(store, {
    identity: input.identity,
    tier: input.tier,
    cost,
    nowMs: input.nowMs,
  });
  if (!checked.allowed) {
    return {
      allowed: false,
      used: checked.used,
      remaining: checked.remaining,
      allowance,
      windowId: checked.windowId,
      resetMs: checked.resetMs,
      operation: input.operation,
      policyVersion,
      tier: input.tier,
    };
  }
  const { used } = await recordConsumption(store, {
    identity: input.identity,
    tier: input.tier,
    windowId: checked.windowId,
    cost,
    operation: input.operation,
    policyVersion,
    requestId: input.requestId,
  });
  return {
    allowed: true,
    used,
    remaining: Math.max(0, allowance - used),
    allowance,
    windowId: checked.windowId,
    resetMs: checked.resetMs,
    operation: input.operation,
    policyVersion,
    tier: input.tier,
  };
}

export interface QuotaBalance {
  allowance: number;
  used: number;
  remaining: number;
  windowId: string;
  /** Unix seconds (matches X-RateLimit-Reset conventions). */
  reset: number;
  resetMs: number;
  tier: Tier;
  policyVersion: string;
}

/** Read-only balance for an identity/window — never consumes. */
export async function getBalance(
  store: QuotaStore,
  identity: string,
  tier: Tier = "free",
  nowMs: number = Date.now(),
): Promise<QuotaBalance> {
  requireIdentity(identity);
  const allowance = allowanceForTier(tier);
  const { windowId, resetMs } = quotaWindowFor(nowMs);
  const used = requireBalance(await store.get(identity, windowId));
  return {
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    windowId,
    reset: Math.floor(resetMs / 1000),
    resetMs,
    tier,
    policyVersion: QUOTA_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Default store selection: in-memory unless durable accounting is opted in.
// ---------------------------------------------------------------------------

const sharedMemory = new InMemoryQuotaStore();
let override: QuotaStore | null = null;
let envResolved = false;
let envStore: QuotaStore | null = null;

export function setQuotaStore(store: QuotaStore | null): void {
  override = store;
}

/**
 * Resolve the active store. An explicit override (tests, embedding apps)
 * wins; otherwise the shared in-memory default serves — UNLESS durable
 * accounting is opted in via `TUBELENS_QUOTA_DURABLE=1` with `DATABASE_URL`
 * present, in which case the Postgres ledger backs it (see `./quota-ledger`;
 * the server-only import stays behind a dynamic import so this module keeps
 * working under bun).
 *
 * Fail-closed honesty: when durable accounting is opted in but the store
 * cannot be built, this REJECTS (the pipeline maps it to a typed 503) —
 * never a silent fallback to memory that would lose accounting. Success
 * caches; failure retries on the next call so recovery needs no restart.
 * No opt-in (flag unset) simply means in-memory and never throws.
 */
export async function getQuotaStore(): Promise<QuotaStore> {
  if (override) {
    return override;
  }
  if (!envResolved) {
    const resolved = await tryResolveDurableStore();
    if (resolved) {
      envStore = resolved;
      envResolved = true;
    }
  }
  return envStore ?? sharedMemory;
}

/** Test helper: drop overrides, env cache, and in-memory counters. */
export function resetQuotaStore(): void {
  override = null;
  envResolved = false;
  envStore = null;
  sharedMemory.clear();
}

async function tryResolveDurableStore(): Promise<QuotaStore | null> {
  if (process.env.TUBELENS_QUOTA_DURABLE !== "1") {
    return null;
  }
  if (
    typeof process.env.DATABASE_URL !== "string" ||
    process.env.DATABASE_URL.trim() === ""
  ) {
    return null;
  }
  // Server-only chain (Neon client) loads ONLY on this opt-in path — never
  // in tests, never by default. Live `db:migrate` still needs owner Neon
  // credentials before this path has a table to write to.
  const ledger = (await import(
    "./quota-ledger"
  )) as typeof import("./quota-ledger");
  return ledger.postgresQuotaStoreFromEnv();
}
