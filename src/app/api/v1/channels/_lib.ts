// Shared youtubei.js upstream calls for the Phase 4 channel routes.
// Used by route defaultDeps only (lazy youtubei import inside each call, so
// importing this module never touches the server-only singleton and unit
// tests stay network-free). Single 8s fail-fast budget per first-page fetch
// (session + channel + tab), per the API route checklist.

import {
  adaptChannelTab,
  type ChannelFeedKind,
  emptyChannelTab,
  hasChannelTab,
} from "@/lib/channels";
import type { ContinuationSearch } from "@/lib/continuations";

const STRICT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{20,}$/;

// Bounded handle -> UC id map ($0 L0): handle page-1 fetches resolve to the
// UC-keyed entry, but without this the resolveURL call itself runs upstream
// on every @handle request. TTL ~1h, capped at 500 handles (LRU-ish: oldest
// key evicted). Negative results are NOT cached — a typo or not-yet-created
// handle retries upstream next time instead of sticking a 404 in memory.
const HANDLE_TTL_MS = 60 * 60 * 1000;
const HANDLE_MAX = 500;

const handleCache = new Map<string, { id: string; expiresAt: number }>();

export function lookupHandle(handle: string): string | undefined {
  const entry = handleCache.get(handle);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    handleCache.delete(handle);
    return undefined;
  }
  return entry.id;
}

export function storeHandle(
  handle: string,
  id: string,
  ttlMs: number = HANDLE_TTL_MS,
): void {
  if (handleCache.size >= HANDLE_MAX && !handleCache.has(handle)) {
    const oldest = handleCache.keys().next();
    if (!oldest.done) {
      handleCache.delete(oldest.value);
    }
  }
  handleCache.set(handle, { id, expiresAt: Date.now() + ttlMs });
}

/** Test helper — clears the handle -> UC id map. */
export function clearHandleCache(): void {
  handleCache.clear();
}

interface RawChannel {
  has_videos?: boolean;
  has_shorts?: boolean;
  has_live_streams?: boolean;
  getVideos?: () => Promise<unknown>;
  getShorts?: () => Promise<unknown>;
  getLiveStreams?: () => Promise<unknown>;
}

/**
 * UC id or @handle -> canonical UC channel id. UC ids pass through with no
 * upstream call; handles resolve via navigation/resolve_url, whose browse
 * endpoint payload carries the canonical browseId.
 */
export async function defaultResolveChannelId(input: string): Promise<string> {
  if (STRICT_CHANNEL_ID.test(input)) {
    return input;
  }
  const key = input.toLowerCase();
  const cached = lookupHandle(key);
  if (cached) {
    return cached;
  }
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  const resolved = await withTimeout(async () => {
    const innertube = await getInnertube();
    const endpoint = (await innertube.resolveURL(
      `https://www.youtube.com/${input}`,
    )) as unknown as {
      payload?: { browseId?: unknown; browse_id?: unknown };
    };
    const browseId =
      (typeof endpoint?.payload?.browseId === "string" &&
        endpoint.payload.browseId) ||
      (typeof endpoint?.payload?.browse_id === "string" &&
        endpoint.payload.browse_id) ||
      undefined;
    if (!browseId || !STRICT_CHANNEL_ID.test(browseId)) {
      throw new Error(`channel_not_found: could not resolve handle "${input}"`);
    }
    return browseId;
  }, 8000);
  storeHandle(key, resolved);
  return resolved;
}

/** Canonical UC id -> raw getChannel payload for mapChannelProfile. */
export async function defaultFetchProfile(channelId: string): Promise<unknown> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    return (await innertube.getChannel(channelId)) as unknown;
  }, 8000);
}

type TabShape = Parameters<typeof adaptChannelTab>[0];

/**
 * Canonical UC id -> adapted first tab page for a feed kind. Tabs are
 * navigated via channel.getVideos()/getShorts()/getLiveStreams() guarded by
 * has_* — a missing tab (e.g. a channel with no shorts shelf) yields a
 * terminal empty page, never a 404. Never touches FeedFilterChipBar
 * internals: items come from the Feed `videos` memo getter.
 */
export async function defaultFetchFirstPage(
  channelId: string,
  kind: ChannelFeedKind,
): Promise<ContinuationSearch> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    const channel = (await innertube.getChannel(channelId)) as RawChannel;
    // Symmetric guard: only an explicit `false` skips the tab call (missing
    // tab -> terminal empty page). Unknown flags proceed to the guarded
    // getTab call below, whose missing-method fallback is the same empty
    // page rather than a throw.
    if (!hasChannelTab(channel, kind)) {
      return emptyChannelTab();
    }
    const getTab =
      kind === "videos"
        ? channel.getVideos
        : kind === "shorts"
          ? channel.getShorts
          : channel.getLiveStreams;
    if (typeof getTab !== "function") {
      return emptyChannelTab();
    }
    const tab = (await getTab.call(channel)) as TabShape;
    return adaptChannelTab(tab);
  }, 8000);
}

export async function defaultContinueFeed(
  page: ContinuationSearch,
): Promise<ContinuationSearch> {
  const { withTimeout } = await import("@/lib/youtube");
  return (await withTimeout(
    () => page.getContinuation(),
    8000,
  )) as ContinuationSearch;
}
