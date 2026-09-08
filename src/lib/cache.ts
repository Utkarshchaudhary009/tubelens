// L0 in-memory cache: tiny TTL Map with stale-while-revalidate semantics.
// $0 ladder level L0 — dedupes hot keys within one instance. L1 is handled
// via Cache-Control headers set per route (see lib/envelope.ts).

interface Entry {
  value: unknown;
  expiresAt: number;
  staleUntil: number;
}

const store = new Map<string, Entry>();

const MAX_SIZE = 500;

/** In-flight fetches by key for cold-key request coalescing. */
const inflight = new Map<string, Promise<unknown>>();

function evictIfNeeded(): void {
  if (store.size <= MAX_SIZE) {
    return;
  }
  const oldest = store.keys().next();
  if (!oldest.done) {
    store.delete(oldest.value);
  }
}

/** Fresh or stale read. Returns undefined on miss or fully-expired entry. */
export function cacheGet<T>(
  key: string,
): { value: T; stale: boolean } | undefined {
  const entry = store.get(key);
  if (!entry) {
    return undefined;
  }
  const now = Date.now();
  if (now <= entry.expiresAt) {
    return { value: entry.value as T, stale: false };
  }
  if (now <= entry.staleUntil) {
    return { value: entry.value as T, stale: true };
  }
  store.delete(key);
  return undefined;
}

export function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
  staleMs = ttlMs,
): void {
  evictIfNeeded();
  const now = Date.now();
  store.set(key, {
    value,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
}

/** Test helper — clears the whole L0 store (plus in-flight coalescing). */
export function clearCache(): void {
  store.clear();
  inflight.clear();
}

export interface CachedResult<T> {
  value: T;
  /** True when served from L0 (fresh or stale). */
  hit: boolean;
  /** True when the upstream fetch failed and a stale copy was served. */
  stale: boolean;
}

/**
 * Cache-first fetch with serve-stale-on-error: on a fresh hit the fetcher
 * never runs; on a cold miss (or expired entry past its stale window) an
 * upstream failure propagates to the caller; on failure with a stale copy
 * available, the stale copy is served so callers can set meta.cached +
 * warnings instead of returning a bare 500.
 *
 * Concurrent misses for one key share a single in-flight fetch (stored per
 * key, removed on settle) so a cold-key burst costs one upstream call.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  staleMs = ttlMs,
): Promise<CachedResult<T>> {
  const found = cacheGet<T>(key);
  if (found && !found.stale) {
    return { value: found.value, hit: true, stale: false };
  }
  const ongoing = inflight.get(key);
  if (ongoing) {
    try {
      return (await ongoing) as CachedResult<T>;
    } catch (err) {
      // Joined a shared fetch that failed: serve our own stale copy when we
      // hold one (cold-miss callers without stale still see the throw).
      if (found) {
        return { value: found.value, hit: true, stale: true };
      }
      throw err;
    }
  }
  let task: Promise<CachedResult<T>> | undefined;
  const runner = (async (): Promise<CachedResult<T>> => {
    try {
      const value = await fetcher();
      cacheSet(key, value, ttlMs, staleMs);
      return { value, hit: false, stale: false };
    } catch (err) {
      if (found) {
        return { value: found.value, hit: true, stale: true };
      }
      throw err;
    } finally {
      if (task !== undefined && inflight.get(key) === task) {
        inflight.delete(key);
      }
    }
  })();
  task = runner;
  inflight.set(key, runner);
  return runner;
}
