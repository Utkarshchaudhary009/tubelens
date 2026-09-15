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

export type AuditAction =
  | "user.tier.changed"
  | "user.role.changed"
  // Reconciliation rows (timeout write later observed at the intended value):
  // final-value equality cannot prove THIS request caused the value (a
  // concurrent update could have produced it, or our write could land after
  // the re-fetch), so these carry a distinct action conveying operation-level
  // reconciliation rather than confirmed causation.
  | "user.tier.change_reconciled"
  | "user.role.change_reconciled"
  | "api_key.issued"
  | "api_key.revoked";
// Phase 05 (Part B): API-key issuance / revocation / rotation. Rotation is
// client-driven (create-new + revoke-old), so it appears as one `issued`
// row plus one `revoked` row sharing the operator reason. Rows carry key
// metadata only — never plaintext secrets (PLANS_AND_USAGE.md §10).

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

export interface TierReconciledEvent extends AuditBase {
  action: "user.tier.change_reconciled";
  oldTier: Tier;
  newTier: Tier;
}

export interface RoleReconciledEvent extends AuditBase {
  action: "user.role.change_reconciled";
  oldRole: UserRole;
  newRole: UserRole;
}

/**
 * Phase 05: a key was issued. `target`/`targetUserId` carry the key's
 * `subject`; `tierAtIssuance` is the subject's authoritative tier at issue
 * time. No secret, ever — the plaintext appears only in the creation
 * response body.
 */
export interface ApiKeyIssuedEvent extends AuditBase {
  action: "api_key.issued";
  /** Clerk key reference (never a plaintext secret). */
  keyId: string;
  name: string;
  scopes: string[];
  tierAtIssuance: Tier;
}

/** Phase 05: a key was revoked (rotation's second half carries the same shape). */
export interface ApiKeyRevokedEvent extends AuditBase {
  action: "api_key.revoked";
  /** Clerk key reference (never a plaintext secret). */
  keyId: string;
  revocationReason?: string;
}

export type AuditEvent =
  | TierAuditEvent
  | RoleAuditEvent
  | TierReconciledEvent
  | RoleReconciledEvent
  | ApiKeyIssuedEvent
  | ApiKeyRevokedEvent;

// Note: `Omit` over a union collapses to common keys, so the input stays an
// explicit union — narrowing on `action` keeps old/new tier/role typed.
export type AuditInput =
  | (Omit<TierAuditEvent, "id" | "ts"> & { ts?: string })
  | (Omit<RoleAuditEvent, "id" | "ts"> & { ts?: string })
  | (Omit<TierReconciledEvent, "id" | "ts"> & { ts?: string })
  | (Omit<RoleReconciledEvent, "id" | "ts"> & { ts?: string })
  | (Omit<ApiKeyIssuedEvent, "id" | "ts"> & { ts?: string })
  | (Omit<ApiKeyRevokedEvent, "id" | "ts"> & { ts?: string });

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
    input.action === "user.tier.changed" ||
    input.action === "user.tier.change_reconciled"
      ? {
          ...base,
          action: input.action,
          oldTier: input.oldTier,
          newTier: input.newTier,
        }
      : input.action === "api_key.issued"
        ? {
            ...base,
            action: input.action,
            keyId: input.keyId,
            name: input.name,
            scopes: [...input.scopes],
            tierAtIssuance: input.tierAtIssuance,
          }
        : input.action === "api_key.revoked"
          ? {
              ...base,
              action: input.action,
              keyId: input.keyId,
              ...(input.revocationReason !== undefined
                ? { revocationReason: input.revocationReason }
                : {}),
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
  // Defensive clone: the stored row must not alias the return value, or a
  // caller mutating it would rewrite history (same shape as the
  // getAuditEvents snapshot below).
  return snapshotAuditEvent(event);
}

/**
 * Snapshot one stored row. Each row is shallow-cloned (`api_key.issued`
 * rows additionally clone their `scopes` array) so callers can neither
 * mutate the store array nor the stored row objects.
 */
function snapshotAuditEvent(event: AuditEvent): AuditEvent {
  return event.action === "api_key.issued"
    ? { ...event, scopes: [...event.scopes] }
    : { ...event };
}

/**
 * Snapshot of rows recorded so far. Each row is shallow-cloned — callers can
 * neither mutate the store array nor the stored row objects (`api_key.issued`
 * rows additionally clone their `scopes` array).
 */
export function getAuditEvents(): AuditEvent[] {
  return events.map(snapshotAuditEvent);
}

/** Clear the store (primarily for tests). */
export function clearAuditEvents(): void {
  events.length = 0;
}
