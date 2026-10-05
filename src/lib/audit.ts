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
import { scrubString } from "./redact";

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
  | "api_key.revoked"
  // Phase 17 (Part B): abuse-control decisions. `actor` is always "system";
  // `ban_queued` never auto-executes — it queues for manual admin approval.
  | "abuse.warned"
  | "abuse.revoked"
  | "abuse.downgraded"
  | "abuse.ban_queued";
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

/**
 * Phase 17: an abuse-control decision. `actor` is always `"system"`;
 * `target`/`targetUserId` carry the Clerk user id for `user:` principals,
 * the key reference for `key:` principals, or `"anonymous"` for the shared
 * anonymous bucket. `oldTier`/`newTier` are set only on `abuse.downgraded`.
 * Reasons are scrubbed + truncated like every other free-text audit field —
 * never secrets, tokens, or raw request bodies.
 */
export interface AbuseAuditEvent extends AuditBase {
  action:
    | "abuse.warned"
    | "abuse.revoked"
    | "abuse.downgraded"
    | "abuse.ban_queued";
  oldTier?: Tier;
  newTier?: Tier;
}

export type AuditEvent =
  | TierAuditEvent
  | RoleAuditEvent
  | TierReconciledEvent
  | RoleReconciledEvent
  | ApiKeyIssuedEvent
  | ApiKeyRevokedEvent
  | AbuseAuditEvent;

// Note: `Omit` over a union collapses to common keys, so the input stays an
// explicit union — narrowing on `action` keeps old/new tier/role typed.
export type AbuseAuditInput = Omit<AbuseAuditEvent, "id" | "ts"> & {
  ts?: string;
};

export type AuditInput =
  | (Omit<TierAuditEvent, "id" | "ts"> & { ts?: string })
  | (Omit<RoleAuditEvent, "id" | "ts"> & { ts?: string })
  | (Omit<TierReconciledEvent, "id" | "ts"> & { ts?: string })
  | (Omit<RoleReconciledEvent, "id" | "ts"> & { ts?: string })
  | (Omit<ApiKeyIssuedEvent, "id" | "ts"> & { ts?: string })
  | (Omit<ApiKeyRevokedEvent, "id" | "ts"> & { ts?: string })
  | AbuseAuditInput;

/**
 * Abuse-input guard. A plain `===` chain cannot eliminate the abuse member:
 * TypeScript narrows members by single-literal discriminants only, so a
 * member whose `action` is itself a 4-literal union survives every
 * individual check and poisons the trailing else branches. This explicit
 * predicate states the narrowing instead.
 */
function isAbuseAuditInput(input: AuditInput): input is AbuseAuditInput {
  return (
    input.action === "abuse.warned" ||
    input.action === "abuse.revoked" ||
    input.action === "abuse.downgraded" ||
    input.action === "abuse.ban_queued"
  );
}

/** Cap for the process-local buffer: warm servers must not grow it forever. */
const MAX_AUDIT_EVENTS = 1000;

const events: AuditEvent[] = [];

/** Runtime bound matching the zod `reason` schema (≤280 chars). */
const MAX_REASON_CHARS = 280;

/** Runtime bound matching the key-name schema (≤64 chars). */
const MAX_NAME_CHARS = 64;

/**
 * Runtime defense beyond the TS/zod types: scrub secret-shaped values out of
 * operator free text (an operator can paste a token into a reason) and
 * truncate to the schema bound so a direct caller cannot smuggle unbounded
 * input into the log. Returns undefined for undefined (field stays absent).
 */
function cleanFreeText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scrubbed = scrubString(value);
  return scrubbed.length > maxChars ? scrubbed.slice(0, maxChars) : scrubbed;
}

interface AuditRowBase {
  id: string;
  actor: string;
  target: string;
  targetUserId: string;
  ts: string;
  requestId: string;
  reason?: string;
}

/** Build one abuse row field-by-field (old/new tier only when set). */
function abuseRow(
  base: AuditRowBase,
  action: AbuseAuditEvent["action"],
  input: { oldTier?: Tier; newTier?: Tier },
): AbuseAuditEvent {
  return {
    ...base,
    action,
    ...(input.oldTier !== undefined ? { oldTier: input.oldTier } : {}),
    ...(input.newTier !== undefined ? { newTier: input.newTier } : {}),
  };
}

/**
 * Append one sanitized audit row and emit a structured log line. Builds the
 * stored row field-by-field (never spreads caller input) so secrets smuggled
 * into extra keys can never reach the log.
 */
export function recordAuditEvent(input: AuditInput): AuditEvent {
  const reason = cleanFreeText(input.reason, MAX_REASON_CHARS);
  const base = {
    id: crypto.randomUUID(),
    action: input.action,
    actor: input.actor,
    target: input.target,
    targetUserId: input.targetUserId,
    ts: input.ts ?? new Date().toISOString(),
    requestId: input.requestId,
    ...(reason !== undefined ? { reason } : {}),
  };
  // The abuse member goes first via its predicate (see
  // `isAbuseAuditInput`); every remaining member carries a single-literal
  // action, so the `===` chain below narrows exactly like the original
  // ternary did.
  let event: AuditEvent;
  if (isAbuseAuditInput(input)) {
    event = abuseRow(base, input.action, input);
  } else if (input.action === "user.tier.changed") {
    event = {
      ...base,
      action: input.action,
      oldTier: input.oldTier,
      newTier: input.newTier,
    };
  } else if (input.action === "user.tier.change_reconciled") {
    event = {
      ...base,
      action: input.action,
      oldTier: input.oldTier,
      newTier: input.newTier,
    };
  } else if (input.action === "api_key.issued") {
    event = {
      ...base,
      action: input.action,
      keyId: input.keyId,
      name: cleanFreeText(input.name, MAX_NAME_CHARS) ?? "",
      scopes: [...input.scopes],
      tierAtIssuance: input.tierAtIssuance,
    };
  } else if (input.action === "api_key.revoked") {
    event = {
      ...base,
      action: input.action,
      keyId: input.keyId,
      ...(input.revocationReason !== undefined
        ? {
            revocationReason: cleanFreeText(
              input.revocationReason,
              MAX_REASON_CHARS,
            ),
          }
        : {}),
    };
  } else {
    event = {
      ...base,
      action: input.action,
      oldRole: input.oldRole,
      newRole: input.newRole,
    };
  }
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
