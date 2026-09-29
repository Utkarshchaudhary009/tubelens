// Phase 01 platform boundary: usage/quota accounting seam.
// Durable weighted-credit accounting lands in Phases 13–14 (Redis fast
// enforcement + Postgres ledger). Until then the no-op default records
// nothing but keeps the pipeline stage typed and injectable.

export type UsageOutcome = "accepted" | "rejected" | "partial";

/** One priced child inside a batch fan-out (PLANS_AND_USAGE.md §9). */
export interface UsageChildCost {
  route: string;
  operation: string;
  cost: number;
}

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
  /** Effective tier at charge time (Phase 14). */
  tier?: string;
  /** Monthly UTC-calendar window id, e.g. "2026-09" (Phase 14). */
  windowId?: string;
  /** Epoch ms of the next UTC month boundary (Phase 14). */
  resetMs?: number;
  /** Monthly credit allowance for `tier` (Phase 14). */
  allowance?: number;
  /**
   * Batch child-cost summary (Phase 14 seam, full economics Phase 16):
   * priced children of a `batch.execute` event recorded with outcome
   * `partial`. The durable ledger keeps operation + total cost; the summary
   * travels the recorder seam for traces and future economics.
   */
  children?: UsageChildCost[];
}

export interface UsageRecordOptions {
  /**
   * Aborted when best-effort accounting exceeds its time bound. Optional
   * so existing recorders stay compatible; recorders that honor it should
   * stop work promptly on abort.
   */
  signal?: AbortSignal;
}

export interface UsageRecorder {
  record(event: UsageEvent, options?: UsageRecordOptions): Promise<void> | void;
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
