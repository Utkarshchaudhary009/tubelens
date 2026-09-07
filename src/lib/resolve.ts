// Pure YouTube URL classifier for /api/v1/resolve — no upstream calls.
// Pure by design so it is unit-testable without network access.

export type ResolvedType = "video" | "short" | "live" | "playlist" | "channel";

export interface ResolvedUrl {
  type: ResolvedType;
  /** Canonical id: video id, playlist id, channel id, or @handle. */
  id: string;
  /** Present when a watch/short/live URL also carries ?list=. */
  playlistId?: string;
  canonicalUrl: string;
}

export class UnresolvableError extends Error {
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "UnresolvableError";
    this.hint = hint;
  }
}

const HINT =
  "Provide a youtube.com, youtu.be, music.youtube.com, or youtube-nocookie.com video, Short, live, playlist, or channel URL.";

function fail(message: string): never {
  throw new UnresolvableError(message, HINT);
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
// Channel ids (UC…), handles (@…), legacy /c/ and /user/ names.
const CHANNEL_ID =
  /^(?:@[A-Za-z0-9_.-]{1,64}|UC[A-Za-z0-9_-]{20,}|[A-Za-z0-9_.-]{1,64})$/;

function video(id: string, playlistId?: string): ResolvedUrl {
  if (!VIDEO_ID.test(id)) {
    fail(`Not a valid video id: "${id}".`);
  }
  const out: ResolvedUrl = {
    type: "video",
    id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
  };
  if (playlistId) {
    out.playlistId = playlistId;
  }
  return out;
}

function playlist(id: string): ResolvedUrl {
  if (!PLAYLIST_ID.test(id)) {
    fail(`Not a valid playlist id: "${id}".`);
  }
  return {
    type: "playlist",
    id,
    canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
  };
}

function channel(id: string): ResolvedUrl {
  if (!CHANNEL_ID.test(id)) {
    fail(`Not a valid channel identifier: "${id}".`);
  }
  const path = id.startsWith("@")
    ? id
    : id.startsWith("UC")
      ? `channel/${id}`
      : `c/${id}`;
  return {
    type: "channel",
    id,
    canonicalUrl: `https://www.youtube.com/${path}`,
  };
}

function firstSegment(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

/**
 * Classify a YouTube URL (or bare video id / @handle) without any
 * upstream call. Throws UnresolvableError with a hint on invalid input.
 */
export function classifyUrl(input: string): ResolvedUrl {
  const raw = (input ?? "").trim();
  if (!raw) {
    fail("Empty URL.");
  }

  // Bare 11-char video id (convenience — clients paste ids too).
  if (VIDEO_ID.test(raw)) {
    return video(raw);
  }
  // Bare @handle.
  if (/^@[A-Za-z0-9_.-]{1,64}$/.test(raw)) {
    return channel(raw);
  }

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    fail(`Could not parse as a URL: "${raw}".`);
  }

  const host = url.hostname.toLowerCase();
  const isYouTube =
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  if (!isYouTube) {
    fail(`Not a YouTube host: "${url.hostname}".`);
  }

  const params = url.searchParams;
  const list = params.get("list");
  const playlistId = list && PLAYLIST_ID.test(list) ? list : undefined;

  // youtu.be/<id>[?list=][?t=]
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    const segs = firstSegment(url.pathname);
    if (segs.length === 0 || !segs[0]) {
      fail("youtu.be URL is missing a video id.");
    }
    return video(segs[0], playlistId);
  }

  const segs = firstSegment(url.pathname);
  const head = segs[0] ?? "";

  // /watch?v=<id>[&list=]
  if (head === "watch") {
    const v = params.get("v");
    if (v) {
      return video(v, playlistId);
    }
    if (playlistId) {
      return playlist(playlistId);
    }
    fail("Watch URL has neither a v= video id nor a list= playlist id.");
  }

  // /shorts/<id>[?list=]
  if (head === "shorts") {
    const id = segs[1] ?? "";
    if (!id) {
      fail("Shorts URL is missing a video id.");
    }
    const out = video(id, playlistId);
    return {
      ...out,
      type: "short",
      canonicalUrl: `https://www.youtube.com/shorts/${id}`,
    };
  }

  // /live/<id>[?list=]
  if (head === "live") {
    const id = segs[1] ?? "";
    if (!id) {
      fail("Live URL is missing a video id.");
    }
    const out = video(id, playlistId);
    return {
      ...out,
      type: "live",
      canonicalUrl: `https://www.youtube.com/live/${id}`,
    };
  }

  // /embed/<id> and legacy /v/<id>
  if (head === "embed" || head === "v") {
    const id = segs[1] ?? "";
    if (!id) {
      fail("Embed URL is missing a video id.");
    }
    return video(id, playlistId);
  }

  // /playlist?list=
  if (head === "playlist") {
    if (playlistId) {
      return playlist(playlistId);
    }
    fail("Playlist URL is missing a list= id.");
  }

  // /channel/<id>
  if (head === "channel") {
    const id = segs[1] ?? "";
    if (!id) {
      fail("Channel URL is missing a channel id.");
    }
    return channel(id);
  }

  // Legacy /c/<name> and /user/<name>
  if (head === "c" || head === "user") {
    const name = segs[1] ?? "";
    if (!name) {
      fail("Channel URL is missing a name.");
    }
    return channel(name);
  }

  // /@handle[/videos|/shorts|/streams...] — only the handle identifies it.
  if (head.startsWith("@")) {
    return channel(head);
  }

  // /watch-style attribution or any other path carrying ?v= (e.g. music
  // share links, /attribution links).
  const v = params.get("v");
  if (v) {
    return video(v, playlistId);
  }
  if (playlistId && segs.length === 0) {
    return playlist(playlistId);
  }

  fail(`Could not identify a video, playlist, or channel in "${raw}".`);
}
