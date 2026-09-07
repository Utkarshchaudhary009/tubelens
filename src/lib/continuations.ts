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
  /**
   * Returns the NEXT page as a new object; never mutates this one. Mirrors
   * youtubei.js Search.getContinuation(), which returns a new Search built
   * from the continuation response (results hold only the new items).
   */
  getContinuation: () => Promise<ContinuationSearch>;
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
  // Store while there is anything left to serve: an upstream continuation OR
  // unconsumed buffered items (a fetched page may hold more items than one
  // response page serves). Otherwise there is nothing to page to -> null.
  if (!search.has_continuation && returned >= search.results.length) {
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

/** True while an entry still has buffered or upstream items to serve. */
export function hasMoreResults(entry: ContinuationEntry): boolean {
  return (
    entry.returned < entry.search.results.length ||
    entry.search.has_continuation
  );
}

/**
 * Forks a FRESH cursor from a live one for L0 cache hits. The fork snapshots
 * the buffered results and delegates continuation to the same source page,
 * but owns its own entry (offset + advancement) — serveContinuation advances
 * entries copy-on-write (a fetched page is stored under a NEW cursor, the
 * source entry is never mutated), so concurrent users of one cached query
 * never share mutable pagination state. Returns null when the source is
 * gone/expired/exhausted; callers degrade to next: null, never a dangle.
 */
export function forkContinuation(cursor: string | null): string | null {
  if (!cursor) {
    return null;
  }
  const entry = takeContinuation(cursor);
  if (!entry || !hasMoreResults(entry)) {
    return null;
  }
  const source = entry.search;
  const fork: ContinuationSearch = {
    results: [...source.results],
    has_continuation: source.has_continuation,
    getContinuation: () => source.getContinuation(),
  };
  return storeContinuation(fork, entry.returned);
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
