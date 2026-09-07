// Opaque pagination-cursor store for /api/v1/search.
// youtubei Search continuations live on the Search object, which cannot
// cross instances — so live Search objects are kept in this L0 map keyed by
// an opaque cursor id (5-min TTL, capped at 100). A cursor that misses (cold
// instance, eviction, expiry) resolves to null and callers serve an empty
// page with next: null rather than an error, per the Phase 1 contract.
// Pure lib module (no server-only import) so it is unit-testable.

export interface ContinuationSearch {
  results: unknown[];
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}

export interface ContinuationEntry {
  search: ContinuationSearch;
  returned: number;
  expiresAt: number;
}

export const CONTINUATION_TTL_MS = 5 * 60 * 1000;

const MAX_CONTINUATIONS = 100;

const store = new Map<string, ContinuationEntry>();

function mintCursor(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64url");
}

export function storeContinuation(
  search: ContinuationSearch,
  returned: number,
): string | null {
  if (!search.has_continuation) {
    return null;
  }
  if (store.size >= MAX_CONTINUATIONS) {
    const oldest = store.keys().next();
    if (!oldest.done) {
      store.delete(oldest.value);
    }
  }
  const cursor = mintCursor();
  store.set(cursor, {
    search,
    returned,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  });
  return cursor;
}

export function takeContinuation(
  cursor: string,
): ContinuationEntry | undefined {
  const entry = store.get(cursor);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(cursor);
    return undefined;
  }
  return entry;
}

export function hasContinuation(cursor: string): boolean {
  return takeContinuation(cursor) !== undefined;
}

export function dropContinuation(cursor: string): void {
  store.delete(cursor);
}

/**
 * A cached/stored cursor is only ever served while its entry is still live.
 * Evicted, expired, or foreign-instance cursors resolve to null, so a
 * served `page.next` never dangles.
 */
export function resolveNext(cursor: string | null): string | null {
  if (!cursor) {
    return null;
  }
  return hasContinuation(cursor) ? cursor : null;
}

/** Test helper — clears the whole continuation store. */
export function clearContinuations(): void {
  store.clear();
}
