// Phase 12 (Part B): distributed Redis rate-limit engine.
//
// Centralized policy lives HERE — routes declare endpoint class/cost and
// never copy numbers. Two sliding windows, both enforced per principal:
//   burst     60 requests / 10s window  (short spike protection)
//   sustained 100 requests / 60s window (matches the Part A stub headers,
//             so unconfigured deployments stay byte-identical)
// Deny when EITHER window is exhausted. Cost (default 1, reserved for the
// Phase 13 weighted-credit model) is applied as the increment weight.
//
// Backend: Upstash Redis (REST client — correct for Vercel serverless, no
// TCP). Each window is a sorted set keyed
// `rl:v1:{sanitized identity}:{sanitized endpointClass}:{burst|sustained}`
// scored by request timestamp. One atomic Lua script per check (EVAL) does
// trim (ZREMRANGEBYSCORE) → count (ZCARD) → conditional add (ZADD x cost +
// EXPIRE) for BOTH windows, so concurrent instances share one exact limit.
// Fail closed: Redis errors/timeouts/malformed replies THROW and the
// pipeline maps that to a typed 503 — never silently allow.
//
// Provider selection: `getRateLimitProvider()` lazily returns a shared
// Redis-backed singleton when BOTH env vars below are present/non-blank,
// else the allow-all default (Part A wire contract unchanged).
//
// Env (Upstash Redis — Vercel Project Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL    e.g. https://<id>.upstash.io (no default)
//   UPSTASH_REDIS_REST_TOKEN  bearer token for the REST API (server-only)
// Unset/blank either one → allow-all default; never log these values or
// full Redis keys (error paths use static messages only).
//
// Pure and server-only-safe: this module deliberately avoids
// `import "server-only"` (that package throws unconditionally under bun,
// which would make this module untestable — same rationale as
// `authorize.ts`/`clerk-auth.ts`); the no-client guarantee comes from the
// import graph (API-only repo, Route Handlers only).

import { Redis } from "@upstash/redis";

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

// ---------------------------------------------------------------------------
// Centralized policy (single source of truth — never copy into routes).
// ---------------------------------------------------------------------------

/** Policy version, stamped on decisions later and on usage rows (Ph. 13+). */
export const RATE_LIMIT_POLICY_VERSION = "2026-09-16.free.v1";

/** Burst window: short spike protection (PLANS_AND_USAGE.md §7–§8). */
export const RATE_LIMIT_BURST_LIMIT = 60;
export const RATE_LIMIT_BURST_WINDOW_MS = 10_000;

/** Sustained window: matches the Part A stub headers (100/60s). */
export const RATE_LIMIT_SUSTAINED_LIMIT = 100;
export const RATE_LIMIT_SUSTAINED_WINDOW_MS = 60_000;

/** Redis key prefix (v1 allows a future policy/rotation namespace). */
export const RATE_LIMIT_KEY_PREFIX = "rl:v1";

/**
 * Fail-fast budget for the whole check (trim+count+conditional add).
 * Matches the repo's standard 8s fail-fast budget; a hung backend fails
 * closed to the pipeline's 503 rather than stalling the response.
 */
export const RATE_LIMIT_BACKEND_TIMEOUT_MS = 8000;

/** Max length of one sanitized key part (bounds Redis key size). */
const MAX_KEY_PART_LENGTH = 128;

const DELETE_CODE = 127;
const OPEN_BRACE = "{";
const CLOSE_BRACE = "}";
const STAR = "*";
const COLON = ":";
const COLON_REPLACEMENT = "_";

export interface RedisRateLimitWindowPolicy {
  limit: number;
  windowMs: number;
}

export interface RedisRateLimitProviderOptions {
  burst?: Partial<RedisRateLimitWindowPolicy>;
  sustained?: Partial<RedisRateLimitWindowPolicy>;
  policyVersion?: string;
  /** Fail-fast budget in ms (default RATE_LIMIT_BACKEND_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Clock override (tests); defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Minimal Redis backend surface: ONE atomic script evaluation per check.
// A real Upstash `Redis` client is adapted via `upstashRateLimitBackend()`;
// tests inject an in-memory stub implementing `eval` with the exact
// semantics of RATE_LIMIT_LUA_SCRIPT below (documented test double).
// ---------------------------------------------------------------------------

/**
 * Atomic check-then-add for both windows. KEYS = [burstKey, sustainedKey].
 * ARGV = [nowMs, burstWindowMs, burstLimit, sustainedWindowMs,
 * sustainedLimit, cost, memberNonce, burstTtlSec, sustainedTtlSec].
 * Returns [allowed, burstCount, burstOldest, sustainedCount,
 * sustainedOldest]: counts are post-add on allow, current on deny; oldest
 * is the oldest surviving score (or nowMs when the window is empty).
 */
export const RATE_LIMIT_LUA_SCRIPT = `local burst_key = KEYS[1]
local sustained_key = KEYS[2]
local now = tonumber(ARGV[1])
local burst_window = tonumber(ARGV[2])
local burst_limit = tonumber(ARGV[3])
local sustained_window = tonumber(ARGV[4])
local sustained_limit = tonumber(ARGV[5])
local cost = tonumber(ARGV[6])
local nonce = ARGV[7]
local burst_ttl = tonumber(ARGV[8])
local sustained_ttl = tonumber(ARGV[9])
redis.call('ZREMRANGEBYSCORE', burst_key, 0, now - burst_window)
redis.call('ZREMRANGEBYSCORE', sustained_key, 0, now - sustained_window)
local burst_count = redis.call('ZCARD', burst_key)
local sustained_count = redis.call('ZCARD', sustained_key)
local burst_oldest = now
local sustained_oldest = now
local burst_head = redis.call('ZRANGE', burst_key, 0, 0, 'WITHSCORES')
if #burst_head == 2 then burst_oldest = tonumber(burst_head[2]) end
local sustained_head = redis.call('ZRANGE', sustained_key, 0, 0, 'WITHSCORES')
if #sustained_head == 2 then sustained_oldest = tonumber(sustained_head[2]) end
if burst_count + cost > burst_limit or sustained_count + cost > sustained_limit then
  return {0, burst_count, burst_oldest, sustained_count, sustained_oldest}
end
for i = 1, cost do
  redis.call('ZADD', burst_key, now, nonce .. ':b:' .. i)
  redis.call('ZADD', sustained_key, now, nonce .. ':s:' .. i)
end
redis.call('EXPIRE', burst_key, burst_ttl)
redis.call('EXPIRE', sustained_key, sustained_ttl)
return {1, burst_count + cost, burst_oldest, sustained_count + cost, sustained_oldest}`;

export interface RateLimitRedisBackend {
  eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown>;
}

/** Static failure message — backend text/keys never surface to callers. */
const BACKEND_UNAVAILABLE = "Rate-limit backend unavailable.";

/**
 * Adapt a real Upstash Redis REST client to the engine's minimal backend
 * surface. Thin pass-through — no policy, no key logic, no logging.
 */
export function upstashRateLimitBackend(client: Redis): RateLimitRedisBackend {
  return {
    eval(script, keys, args): Promise<unknown> {
      return client.eval(script, keys, args) as Promise<unknown>;
    },
  };
}

// ---------------------------------------------------------------------------
// Key sanitization (fail closed on empty — pipeline maps throw to 503).
// ---------------------------------------------------------------------------

/**
 * Strip key-injection characters (C0 control chars, DEL, `{}`/`*`),
 * neutralize `:` (the key separator — so `("a:b","c")` can never collide
 * with `("a","b:c")`), and bound the length so caller-controlled
 * identity/class values cannot escape the
 * `rl:v1:{identity}:{class}:{window}` structure or grow keys unboundedly.
 * Written as a code-point scan (not a regex) so control ranges stay
 * lint-clean.
 */
export function sanitizeRateLimitKeyPart(part: string): string {
  let out = "";
  let kept = 0;
  for (const char of part) {
    if (kept >= MAX_KEY_PART_LENGTH) {
      break;
    }
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 31 ||
      code === DELETE_CODE ||
      char === OPEN_BRACE ||
      char === CLOSE_BRACE ||
      char === STAR
    ) {
      continue;
    }
    out += char === COLON ? COLON_REPLACEMENT : char;
    kept += 1;
  }
  return out;
}

function requireKeyPart(
  raw: string,
  kind: "identity" | "endpointClass",
): string {
  const clean =
    typeof raw === "string" ? sanitizeRateLimitKeyPart(raw).trim() : "";
  if (clean === "") {
    // Static message — never echo the raw value (it may be attacker input).
    throw new Error(
      kind === "identity"
        ? "Rate-limit identity is missing."
        : "Rate-limit endpoint class is missing.",
    );
  }
  return clean;
}

function normalizeCost(cost: number | undefined, burstLimit: number): number {
  const value = cost === undefined ? 1 : cost;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Rate-limit cost must be a finite number.");
  }
  const weight = Math.floor(value);
  if (weight < 1) {
    throw new Error("Rate-limit cost must be at least 1.");
  }
  if (weight > burstLimit) {
    // A single request can never exceed the burst window — reject before
    // any backend contact so no giant write is ever built.
    throw new Error("Rate-limit cost exceeds the burst limit.");
  }
  return weight;
}

// ---------------------------------------------------------------------------
// Redis sliding-window provider.
// ---------------------------------------------------------------------------

interface ResolvedWindow extends RedisRateLimitWindowPolicy {
  name: "burst" | "sustained";
}

function resolveWindow(
  name: "burst" | "sustained",
  fallback: RedisRateLimitWindowPolicy,
  override: Partial<RedisRateLimitWindowPolicy> | undefined,
): ResolvedWindow {
  const limit = Math.floor(override?.limit ?? fallback.limit);
  const windowMs = override?.windowMs ?? fallback.windowMs;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("Rate-limit window limit must be at least 1.");
  }
  if (
    typeof windowMs !== "number" ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  ) {
    throw new Error("Rate-limit window must be positive.");
  }
  return { name, limit, windowMs };
}

/**
 * Race a backend round trip against the remaining fail-fast budget.
 * Best-effort by design: @upstash/redis exposes no per-call abort signal
 * (only a static client-level one), so the race cannot cancel a late
 * flight — harmless here because the script's writes are additive counters
 * only (a late allow over-counts slightly; a late deny wrote nothing).
 */
async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error("Rate-limit backend timed out.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Rate-limit backend timed out."));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Strict script-reply parsing (fail closed): any unknown/malformed shape
 * throws the static backend error — never coerced to 0/allow. Reply must
 * be exactly [allowed, burstCount, burstOldest, sustainedCount,
 * sustainedOldest] with allowed ∈ {0,1} and finite non-negative numbers.
 */
interface ScriptOutcome {
  allowed: boolean;
  burstCount: number;
  burstOldest: number;
  sustainedCount: number;
  sustainedOldest: number;
}

function strictCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  throw new Error(BACKEND_UNAVAILABLE);
}

function strictScore(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new Error(BACKEND_UNAVAILABLE);
}

function parseScriptReply(reply: unknown): ScriptOutcome {
  if (!Array.isArray(reply) || reply.length !== 5) {
    throw new Error(BACKEND_UNAVAILABLE);
  }
  const [
    allowedRaw,
    burstCountRaw,
    burstOldestRaw,
    sustainedCountRaw,
    sustainedOldestRaw,
  ] = reply;
  if (allowedRaw !== 0 && allowedRaw !== 1) {
    throw new Error(BACKEND_UNAVAILABLE);
  }
  return {
    allowed: allowedRaw === 1,
    burstCount: strictCount(burstCountRaw),
    burstOldest: strictScore(burstOldestRaw),
    sustainedCount: strictCount(sustainedCountRaw),
    sustainedOldest: strictScore(sustainedOldestRaw),
  };
}

export function createRedisRateLimitProvider(
  backend: RateLimitRedisBackend,
  options: RedisRateLimitProviderOptions = {},
): RateLimitProvider {
  const burst = resolveWindow(
    "burst",
    { limit: RATE_LIMIT_BURST_LIMIT, windowMs: RATE_LIMIT_BURST_WINDOW_MS },
    options.burst,
  );
  const sustained = resolveWindow(
    "sustained",
    {
      limit: RATE_LIMIT_SUSTAINED_LIMIT,
      windowMs: RATE_LIMIT_SUSTAINED_WINDOW_MS,
    },
    options.sustained,
  );
  const timeoutMs = options.timeoutMs ?? RATE_LIMIT_BACKEND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Rate-limit timeout must be positive.");
  }
  const now = options.now ?? Date.now;

  return {
    async check(check: RateLimitCheck): Promise<RateLimitDecision> {
      const identity = requireKeyPart(check.identity, "identity");
      const endpointClass = requireKeyPart(
        check.endpointClass ?? "default",
        "endpointClass",
      );
      const weight = normalizeCost(check.cost, burst.limit);
      const nowMs = now();
      const nowSec = Math.floor(nowMs / 1000);
      const deadline = Date.now() + timeoutMs;

      const burstKey = `${RATE_LIMIT_KEY_PREFIX}:${identity}:${endpointClass}:burst`;
      const sustainedKey = `${RATE_LIMIT_KEY_PREFIX}:${identity}:${endpointClass}:sustained`;
      const nonce = `${nowMs}:${Math.floor(Math.random() * 1_000_000_000)}`;

      // Single atomic round trip: the script trims, counts, and
      // conditionally adds for BOTH windows. Backend invocation, flight,
      // and reply parsing are all inside the try — ANY backend-originated
      // failure normalizes to the static message (never raw backend text,
      // never keys), and the pipeline maps it to 503.
      let outcome: ScriptOutcome;
      try {
        const reply = await withDeadline(
          backend.eval(
            RATE_LIMIT_LUA_SCRIPT,
            [burstKey, sustainedKey],
            [
              nowMs,
              burst.windowMs,
              burst.limit,
              sustained.windowMs,
              sustained.limit,
              weight,
              nonce,
              Math.ceil(burst.windowMs / 1000),
              Math.ceil(sustained.windowMs / 1000),
            ],
          ),
          deadline,
        );
        outcome = parseScriptReply(reply);
      } catch (error) {
        if (error instanceof Error && error.message === BACKEND_UNAVAILABLE) {
          throw error;
        }
        throw new Error(BACKEND_UNAVAILABLE);
      }

      // Stable headers: every decision reports the sustained limit — the
      // binding constraint surfaces only via remaining/reset/retryAfter.
      if (outcome.allowed) {
        return {
          allowed: true,
          limit: sustained.limit,
          remaining: Math.max(
            0,
            Math.min(
              burst.limit - outcome.burstCount,
              sustained.limit - outcome.sustainedCount,
            ),
          ),
          reset: nowSec + Math.ceil(sustained.windowMs / 1000),
        };
      }

      // Deny: the binding constraint is the window that stays exhausted
      // longest (a request must wait for BOTH windows to have room).
      const burstReset = Math.floor(
        (outcome.burstOldest + burst.windowMs) / 1000,
      );
      const sustainedReset = Math.floor(
        (outcome.sustainedOldest + sustained.windowMs) / 1000,
      );
      const burstFull = outcome.burstCount + weight > burst.limit;
      const sustainedFull = outcome.sustainedCount + weight > sustained.limit;
      // reset tracks only the exhausted windows (deny implies ≥1): the
      // request lifts when the LAST full window frees a slot.
      const fullResets: number[] = [];
      if (burstFull) {
        fullResets.push(burstReset);
      }
      if (sustainedFull) {
        fullResets.push(sustainedReset);
      }
      const latest = Math.max(...fullResets);
      const retryAfter = Math.max(1, latest - nowSec);
      return {
        allowed: false,
        limit: sustained.limit,
        remaining: 0,
        reset: latest > nowSec ? latest : nowSec + retryAfter,
        retryAfter,
      };
    },
  };
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

function upstashEnvPresent(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return (
    typeof url === "string" &&
    url.trim() !== "" &&
    typeof token === "string" &&
    token.trim() !== ""
  );
}

let override: RateLimitProvider | null = null;

interface RedisSingleton {
  url: string;
  token: string;
  provider: RateLimitProvider;
}

let redisSingleton: RedisSingleton | null = null;

/**
 * Build the Redis-backed provider for one credential pair. Construction
 * itself cannot fail open: any throw becomes a poison provider whose
 * check throws the static message, which the pipeline maps to 503.
 */
function redisProviderOrPoison(url: string, token: string): RateLimitProvider {
  try {
    return createRedisRateLimitProvider(
      upstashRateLimitBackend(new Redis({ url, token })),
    );
  } catch {
    return {
      check(): Promise<RateLimitDecision> {
        throw new Error(BACKEND_UNAVAILABLE);
      },
    };
  }
}

export function setRateLimitProvider(provider: RateLimitProvider): void {
  override = provider;
}

/**
 * Lazy provider selection: an explicit override wins; otherwise a shared
 * Redis-backed singleton is built on first use when BOTH
 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are
 * present/non-blank — else the allow-all default (Part A wire contract
 * byte-identical when unconfigured). The singleton is keyed on the
 * credential pair, so rotating either env var rebuilds it.
 */
export function getRateLimitProvider(): RateLimitProvider {
  if (override) {
    return override;
  }
  if (upstashEnvPresent()) {
    const url = (process.env.UPSTASH_REDIS_REST_URL as string).trim();
    const token = (process.env.UPSTASH_REDIS_REST_TOKEN as string).trim();
    if (
      !redisSingleton ||
      redisSingleton.url !== url ||
      redisSingleton.token !== token
    ) {
      redisSingleton = {
        url,
        token,
        provider: redisProviderOrPoison(url, token),
      };
    }
    return redisSingleton.provider;
  }
  return allowAllRateLimitProvider;
}

export function resetRateLimitProvider(): void {
  override = null;
  redisSingleton = null;
}
