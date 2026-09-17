// Phase 14 (Part B): durable usage ledger for weighted-credit accounting.
//
// `usage_ledger` is the durable record of consumed/quota-relevant usage per
// plans/PLANS_AND_USAGE.md sections 9+12: one row per accounted outcome
// (accepted | rejected | partial) stamping principal, tier, operation, cost,
// policy version, window id, request id, and billing key. Balances sum ONLY
// `accepted` rows (see `src/lib/quota-ledger.ts`); rejected/partial rows are
// explainability history with their stamped policy version — section 14:
// history is never reinterpreted under today's price.
//
// Two ids per row, deliberately: `request_id` is the TRACING correlation id
// (the pipeline's X-Request-Id, which callers may echo — never trusted for
// charging), while `billing_key` is the server-minted per-attempt
// idempotency key charging dedupes on. Replaying one request id across
// distinct attempts still charges every attempt.
//
// Postgres is not a cache: keep large derived payload caches out of here
// (CDN + in-memory default per plans/PLAN.md Phase 00).

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: serial("id").primaryKey(),
    /** Accountable identity, e.g. "user:user_123" — never a plaintext secret. */
    principal: text("principal").notNull(),
    /** Effective tier at charge time (free|plus|pro|enterprise). */
    tier: text("tier").notNull(),
    /** Logical operation, e.g. "videos.get" (quota.ts catalog). */
    operation: text("operation").notNull(),
    /** Weighted-credit cost charged under `policyVersion`. */
    cost: integer("cost").notNull(),
    /** Quota policy version stamped at write time (never reinterpreted). */
    policyVersion: text("policy_version").notNull(),
    /** Monthly UTC-calendar window id, e.g. "2026-09". */
    windowId: text("window_id").notNull(),
    /** accepted | rejected | partial. */
    outcome: text("outcome").notNull(),
    /** Tracing correlation id (client-echoable — never a charging key). */
    requestId: text("request_id").notNull(),
    /**
     * Server-minted per-attempt idempotency key. UNIQUE: one attempt
     * charges at most once, mechanically, no matter how often the tracing
     * request id is replayed.
     */
    billingKey: text("billing_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Balance reads filter exactly on (principal, window_id, accepted).
    index("usage_ledger_principal_window_idx").on(
      table.principal,
      table.windowId,
    ),
    // Idempotency key for consumes (see quota-ledger.ts single-writer
    // rule): one billing key charges at most once, mechanically. The
    // tracing request id stays non-unique on purpose — callers may echo
    // one X-Request-Id across distinct attempts, and every attempt must
    // still charge.
    unique("usage_ledger_billing_key_uid").on(table.billingKey),
    // Ledger rows are charges or history — never negative adjustments.
    check("usage_ledger_cost_nonnegative", sql`${table.cost} >= 0`),
    check(
      "usage_ledger_outcome_values",
      sql`${table.outcome} IN ('accepted', 'rejected', 'partial')`,
    ),
  ],
);
