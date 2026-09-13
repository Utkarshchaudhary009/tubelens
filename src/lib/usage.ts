// Phase 01 platform boundary: usage/quota accounting seam.
// Durable weighted-credit accounting lands in Phases 13–14 (Redis fast
// enforcement + Postgres ledger). Until then the no-op default records
// nothing but keeps the pipeline stage typed and injectable.

export type UsageOutcome = "accepted" | "rejected" | "partial";

export interface UsageEvent {
  requestId: string;
  route: string;
  /** Logical operation, e.g. "videos.get" (cost catalog: Phase 13). */
  operation: string;
  /** Weighted-credit cost (policy catalog: Phase 13). */
  cost: number;
  policyVersion: string;
  outcome: UsageOutcome;
  /** Accountable identity; never a plaintext secret. */
  principal?: string;
  latencyMs?: number;
  cached?: boolean;
}

export interface UsageRecorder {
  record(event: UsageEvent): Promise<void> | void;
}

/** Phase 01 default: accept the event and persist nothing. Never throws. */
export const noopUsageRecorder: UsageRecorder = {
  record(): void {},
};

let current: UsageRecorder = noopUsageRecorder;

export function setUsageRecorder(recorder: UsageRecorder): void {
  current = recorder;
}

export function getUsageRecorder(): UsageRecorder {
  return current;
}

export function resetUsageRecorder(): void {
  current = noopUsageRecorder;
}
