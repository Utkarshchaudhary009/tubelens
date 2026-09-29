// Aggressive in-memory cache for throwaway Cloudflare tunnel URLs.
//
// The transcript provider resolves its base from env-only per request (zero
// Blob reads/writes on the hot path). This cache extends that zero-cost
// property to Blob-published URLs: the tts-tunnel-test workflow POSTs the
// fresh tunnel URL to the `transcript` slot, and transcript requests serve it
// from memory — at most ONE Blob get per TTL per instance on a cold miss,
// zero afterwards. The POST/PUT write path overwrites the entry on save
// (refresh-on-save), so steady state never waits on TTL expiry.
//
// Pure module (no server-only / Blob imports): safe for unit tests. Never
// throws; URL resolution failures fall back to env/stale, never a 500.

import type { TunnelSlot } from "./tunnel-url";

/** Memory TTL: one Blob get per slot per 5 minutes per instance, worst case. */
export const TUNNEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Fail-fast budget for one Blob URL read (transcript path never waits long). */
export const TUNNEL_RESOLVE_BUDGET_MS = 800;

/**
 * Only free Cloudflare quick-tunnel URLs are accepted — never arbitrary
 * hosts. Single definition shared with the tunnel-url write schema, so the
 * cache/env layer enforces the same pin the publisher validates.
 */
export const TUNNEL_URL_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.trycloudflare\.com(?::\d{1,5})?(?:\/.*)?$/;

interface TunnelCacheEntry {
  url: string;
  fetchedAt: number;
}

interface TunnelCacheState {
  entries: Partial<Record<TunnelSlot, TunnelCacheEntry>>;
  inflight: Partial<Record<TunnelSlot, Promise<string | undefined>>>;
}

function cacheState(): TunnelCacheState {
  const g = globalThis as unknown as {
    __tubelensTunnelCache?: TunnelCacheState;
  };
  g.__tubelensTunnelCache ??= { entries: {}, inflight: {} };
  return g.__tubelensTunnelCache;
}

/** Absolute-https check (SSRF floor; the provider runner re-validates + pins). */
export function isHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") {
    return false;
  }
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Cache/env-layer pin: only https `*.trycloudflare.com` URLs are storable or
 * resolvable here. `even https://example.com.evil` is rejected at this layer
 * (the provider runner's per-request providerPin remains as defense in depth).
 */
export function isTunnelUrl(raw: unknown): raw is string {
  return typeof raw === "string" && TUNNEL_URL_RE.test(raw.trim());
}

/**
 * Synchronous memory read: the fresh entry's URL, or undefined on miss/expiry.
 * Non-tunnel entries never serve (defense in depth against pre-pin writes).
 * The transcript hot path uses this only — never awaits Blob per request.
 */
export function getCachedTunnelUrl(
  slot: TunnelSlot,
  now: number = Date.now(),
): string | undefined {
  const entry = cacheState().entries[slot];
  if (
    !entry ||
    !isTunnelUrl(entry.url) ||
    now - entry.fetchedAt > TUNNEL_CACHE_TTL_MS
  ) {
    return undefined;
  }
  return entry.url;
}

/**
 * Overwrite one slot (refresh-on-save path). Only tunnel URLs are stored:
 * blank or non-tunnel values are ignored, never cached.
 */
export function setCachedTunnelUrl(
  slot: TunnelSlot,
  url: string,
  now: number = Date.now(),
): void {
  const value = url.trim();
  if (!isTunnelUrl(value)) {
    return;
  }
  cacheState().entries[slot] = { url: value, fetchedAt: now };
}

/** Drop the memory entry + any joined in-flight read (one slot, or all). */
export function clearTunnelCache(slot?: TunnelSlot): void {
  const state = cacheState();
  if (slot === undefined) {
    for (const key of Object.keys(state.entries) as TunnelSlot[]) {
      delete state.entries[key];
    }
    for (const key of Object.keys(state.inflight) as TunnelSlot[]) {
      delete state.inflight[key];
    }
    return;
  }
  delete state.entries[slot];
  delete state.inflight[slot];
}

export interface ResolveTunnelUrlOptions {
  /** Env pointer (TTS_TRANSCRIPT_URL): preferred over Blob, zero cost. */
  envUrl?: string;
  /** Single Blob read on miss (injected so tests stay offline). */
  read?: (slot: TunnelSlot) => Promise<{ url: string } | string | null>;
  now?: () => number;
  /** Fail-fast budget for the Blob read; expiry falls back to stale/env. */
  timeoutMs?: number;
}

/** Race a promise against a fail-fast budget (budget wins with rejection). */
function readWithBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("tunnel resolve budget exceeded"));
    }, ms);
  });
  // Promise.race attaches handlers to both inputs, so a hung Blob read that
  // settles after the budget fires never surfaces as an unhandled rejection.
  return Promise.race([promise, gate]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Resolution order: fresh memory hit -> valid tunnel-URL env (cached, zero
 * Blob) -> single budget-bounded Blob get (concurrent misses join one
 * in-flight promise, then cached) -> stale memory / env-as-is fallback. Blob
 * failures and budget overruns never throw: URL resolution must never turn a
 * transcript request into a 500.
 */
export async function resolveTunnelUrl(
  slot: TunnelSlot,
  opts: ResolveTunnelUrlOptions = {},
): Promise<string | undefined> {
  const nowFn = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? TUNNEL_RESOLVE_BUDGET_MS;
  const hit = getCachedTunnelUrl(slot, nowFn());
  if (hit !== undefined) {
    return hit;
  }
  const joined = cacheState().inflight[slot];
  if (joined) {
    try {
      return await joined;
    } catch {
      return undefined;
    }
  }
  const envUrl = (opts.envUrl ?? "").trim();
  if (isTunnelUrl(envUrl)) {
    setCachedTunnelUrl(slot, envUrl, nowFn());
    return envUrl;
  }
  if (!opts.read) {
    const stale = cacheState().entries[slot];
    if (stale && isTunnelUrl(stale.url)) {
      return stale.url;
    }
    return undefined;
  }
  const read = opts.read;
  const pending = (async (): Promise<string | undefined> => {
    // Generation stamp: a refresh-on-save (or env cache) that lands while
    // the Blob read is in flight is newer and wins — a slow settle must
    // never clobber it with an older URL.
    const readStarted = nowFn();
    let fetched: string | undefined;
    try {
      const rec = await readWithBudget(read(slot), timeoutMs);
      const url = (typeof rec === "string" ? rec : (rec?.url ?? "")).trim();
      if (isTunnelUrl(url)) {
        fetched = url;
      }
    } catch {
      // Blob/store failure or budget overrun: stale/env fallback below.
    }
    const current = cacheState().entries[slot];
    if (
      fetched !== undefined &&
      (!current || current.fetchedAt <= readStarted)
    ) {
      setCachedTunnelUrl(slot, fetched, nowFn());
      return fetched;
    }
    // A newer write landed mid-read: serve it (or any stale tunnel URL)
    // rather than the older Blob value.
    if (current && isTunnelUrl(current.url)) {
      return current.url;
    }
    return undefined;
  })();
  cacheState().inflight[slot] = pending;
  try {
    return await pending;
  } finally {
    if (cacheState().inflight[slot] === pending) {
      delete cacheState().inflight[slot];
    }
  }
}
