// Phase 14 (Part B): durable usage ledger for weighted-credit accounting.
//
// `usage_ledger` is the durable record of consumed/quota-relevant usage per
// plans/PLANS_AND_USAGE.md sections 9+12: one row per accounted outcome
// (accepted | rejected | partial) stamping principal, tier, operation, cost,
// policy version, window id, and request id. Balances sum ONLY `accepted`
// rows (see `src/lib/quota-ledger.ts`); rejected/partial rows are
// explainability history with their stamped policy version — section 14:
// history is never reinterpreted under today's price.
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
    requestId: text("request_id").notNull(),
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
    // rule): one request id charges at most once, mechanically.
    unique("usage_ledger_request_id_uid").on(table.requestId),
    // Ledger rows are charges or history — never negative adjustments.
    check("usage_ledger_cost_nonnegative", sql`${table.cost} >= 0`),
    check(
      "usage_ledger_outcome_values",
      sql`${table.outcome} IN ('accepted', 'rejected', 'partial')`,
    ),
  ],
);
