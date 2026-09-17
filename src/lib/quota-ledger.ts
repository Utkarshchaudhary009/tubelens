// Phase 14 (Part B): durable Postgres usage-ledger writer.
//
// Optional durability behind the `QuotaStore` / `UsageRecorder` seams —
// NOT the default. The pipeline serves from the in-memory store unless the
// operator opts in (`TUBELENS_QUOTA_DURABLE=1` + `DATABASE_URL`, resolved via
// `postgresQuotaStoreFromEnv`). Live `db:migrate` still needs owner Neon
// credentials before this path has a table to write to (see
// `drizzle/README.md`); until then this module is exercised by stub-double
// tests only.
//
// Accounting rule: balances sum ONLY `accepted` rows, so future
// `rejected`/`partial` rows (recorded via `recordUsageEvent`) never inflate
// consumption.
//
// Single-writer rule: the STORE owns `accepted` rows — exactly one per
// consume, keyed by a server-minted billing key. A future durable
// `usage.record` MUST skip `outcome === "accepted"` events (it may persist
// rejected/partial) or dedupe on the attempt's billing key. Belt and
// suspenders: `billing_key` is UNIQUE and inserts are ON CONFLICT DO
// NOTHING, so even a double-writing caller is mechanically incapable of
// double-charging one attempt. The tracing `request_id` stays NON-unique
// on purpose: callers may echo one X-Request-Id across distinct attempts
// (the pipeline's resolveRequestId echoes valid caller ids), and every
// attempt must still charge — dedup NEVER keys on it. (Caveat: request ids
// are tracing keys, not unguessable tokens; replaying one id executes the
// handler again and charges again, exactly like a fresh request.)
//
// There is deliberately NO durable usage-event recorder wired into the
// pipeline yet (see the rule above before adding one).
//
// Bun-safe by construction: only type-only imports from the server-only DB
// client chain (`import type` is erased at runtime); the live `Db` handle is
// passed in by the caller. The sole server-only touch is the dynamic
// `import("./db/client")` inside `postgresQuotaStoreFromEnv`, which runs
// only on the explicit opt-in path — never in tests.

import { and, eq, sum } from "drizzle-orm";
import { usageLedger } from "../../drizzle/schema";
import { ConfigError } from "./config";
import type { Db } from "./db/factory";
import { QUOTA_POLICY_VERSION, QuotaPolicyError } from "./quota";
import type { QuotaChargeDetails, QuotaStore } from "./quota-accounting";
import { idempotencyKey, quotaWindowFor } from "./quota-accounting";
import type { UsageEvent, UsageOutcome } from "./usage";

export interface UsageLedgerRow {
  principal: string;
  tier: string;
  operation: string;
  cost: number;
  policyVersion: string;
  windowId: string;
  outcome: UsageOutcome;
  /** Tracing correlation id (client-echoable — never a charging key). */
  requestId: string;
  /** Server-minted per-attempt idempotency key charging dedupes on. */
  billingKey: string;
}

export interface UsageLedgerWriter {
  /** Sum of `accepted` costs for one identity/window (0 when none). */
  sumAccepted(principal: string, windowId: string): Promise<number>;
  /** Persist one ledger row (any outcome). */
  insert(row: UsageLedgerRow): Promise<void>;
}

/** Drizzle-backed writer over the `usage_ledger` table. */
export function drizzleUsageLedgerWriter(db: Db): UsageLedgerWriter {
  return {
    async sumAccepted(principal: string, windowId: string): Promise<number> {
      const rows = await db
        .select({ total: sum(usageLedger.cost) })
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.principal, principal),
            eq(usageLedger.windowId, windowId),
            eq(usageLedger.outcome, "accepted"),
          ),
        );
      const total = rows[0]?.total;
      // Postgres `sum(integer)` arrives as numeric text — never trust it
      // blindly; non-finite collapses to 0 and the engine fails closed on
      // genuinely corrupt balances downstream.
      if (typeof total === "number" && Number.isFinite(total)) {
        return total;
      }
      if (typeof total === "string") {
        const parsed = Number(total);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed;
        }
      }
      return 0;
    },
    async insert(row: UsageLedgerRow): Promise<void> {
      await db
        .insert(usageLedger)
        .values({
          principal: row.principal,
          tier: row.tier,
          operation: row.operation,
          cost: row.cost,
          policyVersion: row.policyVersion,
          windowId: row.windowId,
          outcome: row.outcome,
          requestId: row.requestId,
          billingKey: row.billingKey,
        })
        // Idempotent by server-minted billing key (UNIQUE): a retried
        // record of the SAME attempt is a no-op, never a second charge —
        // while distinct attempts sharing one client-echoed request id
        // carry distinct keys and charge independently.
        .onConflictDoNothing({ target: usageLedger.billingKey });
    },
  };
}

/**
 * Durable `QuotaStore`: every consume inserts one `accepted` row, every
 * balance reads the `accepted` sum. Concurrent consumes may interleave
 * (read-then-insert, not an atomic increment) — acceptable because Redis
 * owns fast burst enforcement (Phase 15); Postgres is the durable record,
 * not the race gate.
 */
export class PostgresQuotaStore implements QuotaStore {
  constructor(private readonly writer: UsageLedgerWriter) {}

  get(identity: string, windowId: string): Promise<number> {
    return this.writer.sumAccepted(identity, windowId);
  }

  async add(
    identity: string,
    windowId: string,
    cost: number,
    details?: QuotaChargeDetails,
  ): Promise<number> {
    // Validate pre-insert: unknown/negative costs are caller bugs and must
    // surface as a typed error, never a Postgres CHECK-violation 500.
    if (!Number.isInteger(cost) || cost < 0) {
      throw new QuotaPolicyError(
        "invalid_quota_cost",
        "Quota cost must be a non-negative integer.",
      );
    }
    await this.writer.insert({
      principal: identity,
      tier: details?.tier ?? "free",
      operation: details?.operation ?? "unknown",
      cost,
      policyVersion: details?.policyVersion ?? QUOTA_POLICY_VERSION,
      windowId,
      outcome: "accepted",
      requestId: details?.requestId ?? "",
      // Never "" and never the client-echoed request id — the column is
      // UNIQUE, so either would silently drop legitimate charges.
      billingKey:
        typeof details?.billingKey === "string" && details.billingKey !== ""
          ? details.billingKey
          : idempotencyKey(),
    });
    return this.writer.sumAccepted(identity, windowId);
  }
}

/**
 * Persist one usage event — `accepted`, `rejected`, or `partial` (e.g. a
 * batch fan-out with a child-cost summary) — as a ledger row. Only
 * `accepted` rows feed balances; the rest are explainability history with
 * their stamped policy version (§14: history never reinterpreted). The
 * billing key defaults to a fresh mint (history rows just need uniqueness);
 * pass the attempt's key to dedupe a retried record of the same attempt.
 */
export async function recordUsageEvent(
  writer: UsageLedgerWriter,
  event: UsageEvent,
  billingKey: string = idempotencyKey(),
): Promise<void> {
  await writer.insert({
    principal: event.principal ?? "anonymous",
    tier: event.tier ?? "free",
    operation: event.operation,
    cost: event.cost,
    policyVersion: event.policyVersion,
    windowId: event.windowId ?? quotaWindowFor(Date.now()).windowId,
    outcome: event.outcome,
    requestId: event.requestId,
    billingKey,
  });
}

/**
 * Env-gated durable store. Returns null unless the operator explicitly opts
 * in (`TUBELENS_QUOTA_DURABLE=1`) with `DATABASE_URL` present — the caller
 * (`getQuotaStore`) falls back to in-memory otherwise. Throws when opted in
 * but the database is unreachable or unconfigured, so a half-configured
 * durable path fails closed instead of silently losing accounting (direct
 * callers must treat null as "not opted in", never as "serve from memory").
 */
export async function postgresQuotaStoreFromEnv(): Promise<PostgresQuotaStore | null> {
  if (process.env.TUBELENS_QUOTA_DURABLE !== "1") {
    return null;
  }
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim() === "") {
    throw new ConfigError(
      "TUBELENS_QUOTA_DURABLE=1 requires DATABASE_URL.",
      "Set DATABASE_URL to the Neon pooled connection string, or unset TUBELENS_QUOTA_DURABLE to stay on the in-memory default.",
    );
  }
  const { getDb } = await import("./db/client");
  return new PostgresQuotaStore(drizzleUsageLedgerWriter(await getDb()));
}
