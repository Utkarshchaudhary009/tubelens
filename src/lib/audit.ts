// Phase 04 (Part B): audit log for tier/role administration.
//
// $0 constraint + deferred Postgres (Phase 24): no durable audit table yet.
// This module keeps a process-local in-memory append log plus one structured
// `console.info` JSON line per mutation, and exports the store so tests can
// assert rows. Each row carries actor/target/old/new/ts/requestId/reason —
// sanitized by construction: only ids, tier/role labels, timestamps, and the
// validated ≤280-char reason are ever persisted. Never put plaintext
// credentials, tokens, or raw request bodies here (PLANS_AND_USAGE.md §10).

import type { UserRole } from "./admin-guard";
import type { Tier } from "./product";

export type AuditAction = "user.tier.changed" | "user.role.changed";

interface AuditBase {
  id: string;
  action: AuditAction;
  /** Acting admin's Clerk user id. */
  actor: string;
  /** Target Clerk user id (alias of targetUserId for §10-style readers). */
  target: string;
  targetUserId: string;
  /** ISO-8601 timestamp of the mutation. */
  ts: string;
  /** Echoed/minted X-Request-Id for operational correlation. */
  requestId: string;
  /** Validated operator reason (≤280 chars), when supplied. */
  reason?: string;
}

export interface TierAuditEvent extends AuditBase {
  action: "user.tier.changed";
  oldTier: Tier;
  newTier: Tier;
}

export interface RoleAuditEvent extends AuditBase {
  action: "user.role.changed";
  oldRole: UserRole;
  newRole: UserRole;
}

export type AuditEvent = TierAuditEvent | RoleAuditEvent;

// Note: `Omit` over a union collapses to common keys, so the input stays an
// explicit union — narrowing on `action` keeps old/new tier/role typed.
export type AuditInput =
  | (Omit<TierAuditEvent, "id" | "ts"> & { ts?: string })
  | (Omit<RoleAuditEvent, "id" | "ts"> & { ts?: string });

/** Cap for the process-local buffer: warm servers must not grow it forever. */
const MAX_AUDIT_EVENTS = 1000;

const events: AuditEvent[] = [];

/**
 * Append one sanitized audit row and emit a structured log line. Builds the
 * stored row field-by-field (never spreads caller input) so secrets smuggled
 * into extra keys can never reach the log.
 */
export function recordAuditEvent(input: AuditInput): AuditEvent {
  const base = {
    id: crypto.randomUUID(),
    action: input.action,
    actor: input.actor,
    target: input.target,
    targetUserId: input.targetUserId,
    ts: input.ts ?? new Date().toISOString(),
    requestId: input.requestId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  const event: AuditEvent =
    input.action === "user.tier.changed"
      ? {
          ...base,
          action: input.action,
          oldTier: input.oldTier,
          newTier: input.newTier,
        }
      : {
          ...base,
          action: input.action,
          oldRole: input.oldRole,
          newRole: input.newRole,
        };
  events.push(event);
  // Bounded buffer: drop the oldest row on overflow so a warm process keeps
  // only the last MAX_AUDIT_EVENTS (durable history lands in Postgres,
  // Phase 24 — this store is a $0 test/ops bridge, not the ledger).
  if (events.length > MAX_AUDIT_EVENTS) {
    events.shift();
  }
  console.info(JSON.stringify({ level: "audit", ...event }));
  return event;
}

/** Snapshot of rows recorded so far (copy — callers cannot mutate the store). */
export function getAuditEvents(): AuditEvent[] {
  return [...events];
}

/** Clear the store (primarily for tests). */
export function clearAuditEvents(): void {
  events.length = 0;
}
