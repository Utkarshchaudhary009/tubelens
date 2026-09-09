// Shared youtubei.js upstream calls for the Phase 5 playlist routes.
// Used by route defaultDeps only (lazy youtubei import inside each call, so
// importing this module never touches the server-only singleton and unit
// tests stay network-free). Single 8s fail-fast budget per first-page fetch,
// per the API route checklist.

import type { ContinuationSearch } from "@/lib/continuations";
import {
  adaptChannelPlaylistsPage,
  adaptPlaylistFeed,
  emptyPlaylistFeed,
} from "@/lib/playlists";

type PlaylistTabShape = Parameters<typeof adaptPlaylistFeed>[0];
type ChannelPlaylistsTabShape = Parameters<typeof adaptChannelPlaylistsPage>[0];

interface RawPlaylist {
  items?: unknown;
  has_continuation: boolean;
  getContinuation: () => Promise<unknown>;
}

interface RawChannel {
  has_playlists?: boolean;
  getPlaylists?: () => Promise<unknown>;
}

/** Playlist id -> raw getPlaylist payload (info + first items page). */
export async function defaultFetchPlaylist(
  playlistId: string,
): Promise<unknown> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    return (await innertube.getPlaylist(playlistId)) as unknown;
  }, 8000);
}

/** Playlist id -> adapted first items page (or terminal empty page). */
export async function defaultFetchPlaylistFirstPage(
  playlistId: string,
): Promise<ContinuationSearch> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    const playlist = (await innertube.getPlaylist(
      playlistId,
    )) as unknown as RawPlaylist;
    if (!playlist || !Array.isArray(playlist.items)) {
      return emptyPlaylistFeed();
    }
    return adaptPlaylistFeed(playlist as PlaylistTabShape);
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

/**
 * Pure tab selector for a fetched Channel object (unit-testable without
 * network): an explicit `has_playlists === false` skips the tab call and
 * yields a terminal empty page; otherwise the guarded getPlaylists() call
 * runs, whose missing-method fallback is the same empty page rather than a
 * throw. Reads the Feed `playlists` memo (NOT `videos` — the getPlaylists
 * tab carries LockupView PLAYLIST nodes there, verified live), with an
 * `items`/raw-current_tab fallback for client drift.
 */
export async function fetchChannelPlaylistsTab(
  channel: RawChannel,
): Promise<ContinuationSearch> {
  if (channel.has_playlists === false) {
    return emptyPlaylistFeed();
  }
  if (typeof channel.getPlaylists !== "function") {
    return emptyPlaylistFeed();
  }
  const tab = (await channel.getPlaylists.call(
    channel,
  )) as ChannelPlaylistsTabShape;
  return adaptChannelPlaylistsPage(tab);
}

/**
 * Canonical UC id -> adapted first channel-playlists page. A channel with no
 * playlists shelf yields a terminal empty page, never a 404.
 */
export async function defaultFetchChannelPlaylistsFirstPage(
  channelId: string,
): Promise<ContinuationSearch> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    const channel = (await innertube.getChannel(channelId)) as RawChannel;
    return fetchChannelPlaylistsTab(channel);
  }, 8000);
}
