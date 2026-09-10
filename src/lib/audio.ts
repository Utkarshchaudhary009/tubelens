// Phase 9 (Audio-first) shared handlers.
// Three flag-gated endpoints with no durable store ($0: CDN + in-memory only):
// - audio:  two modes in ONE route. Without `token` -> JSON envelope carrying
//   a same-origin signed expiring URL (HMAC-SHA256 over `id.exp`); with a
//   valid `token`+`exp` -> proxied audio bytes with HTTP Range support (206).
//   Raw upstream URLs are NEVER exposed in JSON or error bodies.
// - radio:  autoplay continuation queue from a seed video. Automix up-next
//   (RD-mix) first, watch-next continuation chain as fallback, related rail
//   as shortfall fill. >= 25 tracks, deduped, opaque cursor paging.
// - lyrics: timed lines when the source provides them, plain text otherwise.
// All three sit behind TUBELENS_AUDIO_ENABLED (default OFF) until post-v1
// legal review (see plans/NEED_TO_THINK.md gates #2 and #6).

import { createHmac, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { type CachedResult, cached } from "@/lib/cache";
import {
  type ContinuationSearch,
  dropContinuation,
  forkContinuation,
  hasMoreResults,
  storeContinuation,
  takeContinuation,
} from "@/lib/continuations";
import {
  baseHeaders,
  CACHE_CONTROL,
  getRequestId,
  successResponse,
} from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import {
  type ClassifiedVideoError,
  classifyFeedError,
  isUpstreamTimeout,
  mapRelatedItem,
  textOf,
} from "@/lib/mappers";
import {
  isPlausibleVideoId,
  parseLang,
  parseLimit,
  parseRegion,
} from "@/lib/validate";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** Flag-gated until post-v1 legal review. Default OFF: unset/unknown -> off. */
export function isAudioEnabled(): boolean {
  const raw = (process.env.TUBELENS_AUDIO_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function audioDisabledError(): ClassifiedVideoError {
  return {
    code: "audio_disabled",
    message: "Audio endpoints are disabled.",
    hint: "Audio is flag-gated: enable TUBELENS_AUDIO_ENABLED after legal review to use /videos/:id/audio, /radio, and /lyrics.",
    status: 403,
  };
}

// ---------------------------------------------------------------------------
// Signed expiring URLs (HMAC-SHA256 over `id.exp`)
// ---------------------------------------------------------------------------

/** Signed audio URLs live 10 minutes. */
export const AUDIO_URL_TTL_MS = 10 * 60 * 1000;

export function audioSecret(): string {
  const fromEnv = (process.env.TUBELENS_AUDIO_SECRET ?? "").trim();
  return fromEnv !== "" ? fromEnv : "tubelens-dev-audio-secret";
}

export function signAudioToken(
  id: string,
  exp: string,
  secret: string = audioSecret(),
): string {
  return createHmac("sha256", secret).update(`${id}.${exp}`).digest("hex");
}

/**
 * Verifies a minted token: well-formed exp in the future, hex token matching
 * the HMAC (timing-safe). Never throws — any anomaly is simply invalid.
 */
export function verifyAudioToken(
  id: string,
  expRaw: string | null,
  token: string | null,
  nowMs: number = Date.now(),
  secret: string = audioSecret(),
): boolean {
  if (typeof expRaw !== "string" || typeof token !== "string") {
    return false;
  }
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0 || exp * 1000 <= nowMs) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return false;
  }
  const expected = signAudioToken(id, expRaw, secret);
  try {
    return timingSafeEqual(
      Buffer.from(token, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-video kill switch (in-memory; no durable store by default)
// ---------------------------------------------------------------------------

const blockedAudioIds = new Set<string>();
let blockedSeeded = false;

function seedBlockedAudioIds(): void {
  if (blockedSeeded) {
    return;
  }
  blockedSeeded = true;
  for (const part of (process.env.TUBELENS_AUDIO_BLOCKED_IDS ?? "").split(
    ",",
  )) {
    const id = part.trim();
    if (id !== "") {
      blockedAudioIds.add(id);
    }
  }
}

export function isAudioBlocked(id: string): boolean {
  seedBlockedAudioIds();
  return blockedAudioIds.has(id);
}

/**
 * Takedown/abuse kill switch: once marked, the video is NEVER re-served
 * (both JSON and bytes modes check isAudioBlocked first).
 */
export function markAudioBlocked(id: string): void {
  seedBlockedAudioIds();
  blockedAudioIds.add(id);
}

/** Test helper — resets the in-memory blocklist (and its env seeding). */
export function clearAudioBlockedForTests(): void {
  blockedAudioIds.clear();
  blockedSeeded = false;
}

function audioBlockedError(): ClassifiedVideoError {
  return {
    code: "audio_blocked",
    message: "Audio for this video is blocked.",
    hint: "This video was disabled via takedown or abuse review; try a different video.",
    status: 410,
  };
}

// ---------------------------------------------------------------------------
// Error classification (never bare 500s, never leak raw upstream URLs)
// ---------------------------------------------------------------------------

function isDefinitiveAudioError(err: unknown): boolean {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /not_found|not found|\b404\b|\b410\b|gone|private|deleted|removed|unavailable|login_required|copyright|takedown|blocked/i.test(
    raw,
  );
}

/**
 * Blocked/takedown -> 410 audio_unavailable; timeouts -> 504; everything else
 * (incl. decipher failures) -> 502. Callers sanitize upstream messages so no
 * raw URL ever reaches an error body.
 */
export function classifyAudioError(err: unknown): ClassifiedVideoError {
  if (isUpstreamTimeout(err)) {
    return {
      code: "upstream_timeout",
      message: "Audio lookup timed out upstream.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 504,
    };
  }
  if (isDefinitiveAudioError(err)) {
    return {
      code: "audio_unavailable",
      message: "Audio is unavailable for this video.",
      hint: "The audio track may be private, deleted, or taken down; try a different video.",
      status: 410,
    };
  }
  return {
    code: "upstream_degraded",
    message: "Audio lookup failed upstream.",
    hint: "Retry shortly; include X-Request-Id in bug reports.",
    status: 502,
  };
}

function invalidVideoIdHint(example: string): ClassifiedVideoError {
  return {
    code: "invalid_video_id",
    message: "Invalid video id.",
    hint: `Use an 11-character YouTube video id, e.g. /api/v1/videos/dQw4w9WgXcQ/${example}.`,
    status: 400,
  };
}

// ---------------------------------------------------------------------------
// Audio: upstream seam
// ---------------------------------------------------------------------------

export interface AudioFormatInfo {
  mimeType: string;
  bitrate?: number;
  contentLength?: number;
}

export interface AudioBytes {
  /** The exact byte slice for the requested range (or the full body). */
  bytes: Uint8Array;
  contentType: string;
  /** Full stream length (for Content-Range); -1 when unknown. */
  totalLength: number;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface AudioDeps {
  /** Audio-only format metadata (mime/bitrate) — NEVER returns a URL. */
  fetchFormat: (id: string) => Promise<AudioFormatInfo>;
  /** Byte slice for the range (null = full body). Resolves + fetches upstream. */
  fetchRange: (id: string, range: ByteRange | null) => Promise<AudioBytes>;
}

function audioTakedownError(status: number): Error {
  return Object.assign(
    new Error(`audio_unavailable: upstream responded with status ${status}`),
    { name: "UpstreamError", status },
  );
}

function audioUpstreamError(status: number): Error {
  return Object.assign(
    new Error(`Audio upstream responded with status ${status}`),
    { name: "UpstreamError", status },
  );
}

/**
 * Resolves the deciphered audio-only stream URL via youtubei.js
 * getStreamingData (deciphered server-side), then fetches the requested byte
 * range. Thrown messages carry statuses only — the raw URL never escapes.
 */
async function fetchAudioUpstream(
  id: string,
  range: ByteRange | null,
): Promise<AudioBytes> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  const url = await withTimeout(async () => {
    const innertube = await getInnertube();
    const fmt = (await innertube.getStreamingData(id, {
      type: "audio",
    } as Parameters<typeof innertube.getStreamingData>[1])) as unknown as {
      url?: string;
      mime_type?: string;
      decipher?: (player?: unknown) => Promise<string>;
    };
    const player = (innertube.session as unknown as Record<string, unknown>)
      ?.player;
    let resolved = typeof fmt.url === "string" ? fmt.url : "";
    if (typeof fmt.decipher === "function") {
      try {
        resolved = await fmt.decipher(player);
      } catch {
        resolved = typeof fmt.url === "string" ? fmt.url : "";
      }
    }
    if (!resolved) {
      throw new Error("audio_unavailable: no audio format for this video");
    }
    return resolved;
  }, 8000);
  const headers = new Headers();
  if (range) {
    headers.set(
      "Range",
      `bytes=${range.start}-${range.end !== undefined ? range.end : ""}`,
    );
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers });
  if (res.status === 404 || res.status === 410 || res.status === 403) {
    throw audioTakedownError(res.status);
  }
  if (!res.ok && res.status !== 206) {
    throw audioUpstreamError(res.status);
  }
  const contentType = res.headers.get("content-type") ?? "audio/webm";
  let totalLength = -1;
  const contentRange = res.headers.get("content-range");
  const totalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  if (totalMatch?.[1]) {
    totalLength = Number(totalMatch[1]);
  } else {
    const len = res.headers.get("content-length");
    if (len && /^\d+$/.test(len.trim())) {
      totalLength = Number(len.trim());
    }
  }
  // Range responses carry the slice length; full responses carry the total.
  if (res.status === 206 && totalLength < 0) {
    totalLength = -1;
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType,
    totalLength,
  };
}

async function fetchAudioFormatUpstream(id: string): Promise<AudioFormatInfo> {
  const { getInnertube, withTimeout } = await import("@/lib/youtube");
  return withTimeout(async () => {
    const innertube = await getInnertube();
    const fmt = (await innertube.getStreamingData(id, {
      type: "audio",
    } as Parameters<typeof innertube.getStreamingData>[1])) as unknown as {
      mime_type?: string;
      bitrate?: number;
      average_bitrate?: number;
      content_length?: number;
    };
    if (!fmt || typeof fmt.mime_type !== "string") {
      throw new Error("audio_unavailable: no audio format for this video");
    }
    const info: AudioFormatInfo = { mimeType: fmt.mime_type };
    const bitrate =
      typeof fmt.bitrate === "number"
        ? fmt.bitrate
        : typeof fmt.average_bitrate === "number"
          ? fmt.average_bitrate
          : undefined;
    if (bitrate !== undefined) {
      info.bitrate = Math.round(bitrate);
    }
    if (typeof fmt.content_length === "number") {
      info.contentLength = Math.round(fmt.content_length);
    }
    return info;
  }, 8000);
}

export const defaultAudioDeps: AudioDeps = {
  fetchFormat: (id) => fetchAudioFormatUpstream(id),
  fetchRange: (id, range) => fetchAudioUpstream(id, range),
};

// ---------------------------------------------------------------------------
// Audio: Range parsing
// ---------------------------------------------------------------------------

export type ParsedRange =
  | { kind: "none" }
  | { kind: "slice"; start: number; end?: number }
  | { kind: "unsatisfiable" };

/** Parses a Range header against a known total. Garbage -> none (serve 200). */
export function parseRangeHeader(
  raw: string | null,
  total: number,
): ParsedRange {
  if (!raw) {
    return { kind: "none" };
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!m) {
    return { kind: "none" };
  }
  const startRaw = m[1] ?? "";
  const endRaw = m[2] ?? "";
  if (startRaw === "" && endRaw === "") {
    return { kind: "none" };
  }
  if (startRaw === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { kind: "none" };
    }
    if (total >= 0 && suffix >= total) {
      return { kind: "slice", start: 0 };
    }
    return { kind: "slice", start: Math.max(0, total - suffix) };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) {
    return { kind: "none" };
  }
  if (total >= 0 && start >= total) {
    return { kind: "unsatisfiable" };
  }
  if (endRaw === "") {
    return { kind: "slice", start };
  }
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < start) {
    return { kind: "none" };
  }
  return { kind: "slice", start, end };
}

// ---------------------------------------------------------------------------
// Audio: route handler (JSON signed-URL mode + bytes proxy mode)
// ---------------------------------------------------------------------------

export interface SignedAudioDTO {
  url: string;
  expiresAt: string;
  mimeType: string;
  bitrate?: number;
  contentLength?: number;
}

export function mintSignedAudioUrl(
  origin: string,
  id: string,
  nowMs: number = Date.now(),
  secret: string = audioSecret(),
): { url: string; expiresAt: string } {
  const exp = String(Math.floor((nowMs + AUDIO_URL_TTL_MS) / 1000));
  const token = signAudioToken(id, exp, secret);
  return {
    url: `${origin}/api/v1/videos/${encodeURIComponent(id)}/audio?token=${token}&exp=${exp}`,
    expiresAt: new Date(Number(exp) * 1000).toISOString(),
  };
}

export async function handleAudio(
  req: NextRequest,
  id: string,
  deps: AudioDeps = defaultAudioDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  if (!isAudioEnabled()) {
    return errorResponse(requestId, audioDisabledError());
  }
  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("audio"));
  }
  if (isAudioBlocked(id)) {
    return errorResponse(requestId, audioBlockedError());
  }

  // Bytes mode iff a token is presented; otherwise JSON signed-URL mode.
  if (params.get("token") !== null) {
    return serveAudioBytes(req, requestId, id, deps);
  }

  try {
    const format = await deps.fetchFormat(id);
    const { url, expiresAt } = mintSignedAudioUrl(req.nextUrl.origin, id);
    const data: SignedAudioDTO = { url, expiresAt, mimeType: format.mimeType };
    if (format.bitrate !== undefined) {
      data.bitrate = format.bitrate;
    }
    if (format.contentLength !== undefined) {
      data.contentLength = format.contentLength;
    }
    return successResponse(data, {
      requestId,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch (err) {
    const classified = classifyAudioError(err);
    if (classified.code === "audio_unavailable") {
      // Takedown/deleted: never re-serve this video afterwards.
      markAudioBlocked(id);
    }
    return errorResponse(requestId, classified);
  }
}

async function serveAudioBytes(
  req: NextRequest,
  requestId: string,
  id: string,
  deps: AudioDeps,
): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  if (!verifyAudioToken(id, params.get("exp"), params.get("token"))) {
    return errorResponse(requestId, {
      code: "audio_invalid_token",
      message: "Invalid or expired audio token.",
      hint: "Request a fresh signed URL from /videos/:id/audio without token params.",
      status: 403,
    });
  }

  const rangeHeader = req.headers.get("range");
  // Unknown totals still proxy: request the open-ended slice and serve 200
  // when the length cannot be proven (Range is best-effort here).
  let range: ByteRange | null = null;
  let needsPartial = false;
  if (rangeHeader) {
    const trimmed = rangeHeader.trim();
    const open = /^bytes=(\d+)-(\d*)$/.exec(trimmed);
    const suffix = /^bytes=-(\d+)$/.exec(trimmed);
    if (open) {
      const start = Number(open[1]);
      range = { start };
      if (open[2] !== "") {
        range.end = Number(open[2]);
      }
      needsPartial = true;
    } else if (suffix) {
      // Suffix ranges need the total first: fetch full, then slice below.
      range = null;
      needsPartial = true;
    }
  }

  try {
    const audio = await deps.fetchRange(id, range);
    const total = audio.totalLength;
    const headers = baseHeaders(requestId);
    headers.set("Content-Type", audio.contentType);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", CACHE_CONTROL.noStore);

    if (needsPartial && total >= 0) {
      const parsed = parseRangeHeader(rangeHeader, total);
      if (parsed.kind === "unsatisfiable") {
        headers.set("Content-Range", `bytes */${total}`);
        const errRes = errorResponse(requestId, {
          code: "invalid_range",
          message: "Requested range is not satisfiable.",
          hint: `Use a start below ${total}, e.g. Range: bytes=0-.`,
          status: 416,
        });
        // errorResponse rebuilds headers; copy the range specifics over.
        errRes.headers.set("Content-Range", `bytes */${total}`);
        errRes.headers.set("Accept-Ranges", "bytes");
        return errRes;
      }
    }

    if (needsPartial && total >= 0) {
      // Deps return the upstream slice; derive the served span from the
      // requested start and the actual returned length.
      const parsed = parseRangeHeader(rangeHeader, total);
      const start =
        parsed.kind === "slice"
          ? parsed.start
          : Math.max(0, total - audio.bytes.length);
      const end = start + audio.bytes.length - 1;
      headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
      headers.set("Content-Length", String(audio.bytes.length));
      return new NextResponse(audio.bytes as BodyInit, {
        status: 206,
        headers,
      });
    }
    if (total >= 0) {
      headers.set("Content-Length", String(audio.bytes.length));
    }
    return new NextResponse(audio.bytes as BodyInit, {
      status: 200,
      headers,
    });
  } catch (err) {
    const classified = classifyAudioError(err);
    if (classified.code === "audio_unavailable") {
      markAudioBlocked(id);
    }
    return errorResponse(requestId, classified);
  }
}

// ---------------------------------------------------------------------------
// Radio: track DTO + mapping
// ---------------------------------------------------------------------------

export interface RadioTrackDTO {
  id: string;
  title: string;
  channel?: { id?: string; name?: string };
  durationSeconds?: number;
}

/**
 * Maps an automix/watch-next node to a radio track. CompactVideo + LockupView
 * shapes go through mapRelatedItem (video-kind only); PlaylistPanelVideo /
 * AutomixPreviewVideo shapes (video_id + title/author) map directly. Anything
 * else is null and dropped by the assembler.
 */
export function mapRadioTrack(node: unknown): RadioTrackDTO | null {
  const viaRelated = mapRelatedItem(node);
  if (viaRelated && viaRelated.kind === "video") {
    const dto: RadioTrackDTO = { id: viaRelated.id, title: viaRelated.title };
    if (viaRelated.channel) {
      dto.channel = viaRelated.channel;
    }
    if (viaRelated.durationSeconds !== undefined) {
      dto.durationSeconds = viaRelated.durationSeconds;
    }
    return dto;
  }
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const n = node as Record<string, unknown>;
  // Direct panel shape (PlaylistPanelVideo / AutomixPreviewVideo): these
  // carry video_id, or a video-ish type marker plus an id. Anything without
  // a video marker (ads, messages, shelves) is dropped — the fallback must
  // never map arbitrary { id } objects.
  const typeText = typeof n.type === "string" ? n.type.toLowerCase() : "";
  const looksVideo =
    /video|panel|track|song|music/.test(typeText) ||
    typeof n.video_id === "string";
  if (!looksVideo) {
    return null;
  }
  const id =
    (typeof n.video_id === "string" && n.video_id) ||
    (typeof n.id === "string" && n.id) ||
    (typeof n.content_id === "string" && n.content_id) ||
    undefined;
  if (!id) {
    return null;
  }
  const title = textOf(n.title) ?? "Untitled";
  const dto: RadioTrackDTO = { id, title };
  const authorName =
    textOf(n.author) ??
    textOf((n.author as Record<string, unknown> | undefined)?.name);
  const authorId =
    (n.author as Record<string, unknown> | undefined)?.id ??
    (typeof n.channel_id === "string" ? n.channel_id : undefined);
  if (authorName || typeof authorId === "string") {
    dto.channel = {
      ...(typeof authorId === "string" ? { id: authorId } : {}),
      ...(authorName ? { name: authorName } : {}),
    };
  }
  const duration =
    typeof n.duration === "number"
      ? n.duration
      : typeof n.length_seconds === "number"
        ? n.length_seconds
        : typeof n.length_seconds === "string"
          ? Number(n.length_seconds)
          : undefined;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    dto.durationSeconds = Math.round(duration);
  }
  return dto;
}

/** Queue targets: >= 25 served, capped at 50 assembled server-side. */
export const RADIO_TARGET_TRACKS = 25;
export const RADIO_MAX_TRACKS = 50;

/**
 * Merges raw node lists (automix first, then related fill) into a deduped
 * queue: seed id excluded, first-seen order kept, capped at max. Dedup is
 * global, so the first 10 can never repeat.
 */
export function assembleRadioQueue(
  rawLists: unknown[][],
  seedId: string,
  target: number = RADIO_TARGET_TRACKS,
  max: number = RADIO_MAX_TRACKS,
): { tracks: RadioTrackDTO[]; shortfall: boolean } {
  const seen = new Set<string>([seedId]);
  const tracks: RadioTrackDTO[] = [];
  for (const list of rawLists) {
    for (const node of list) {
      if (tracks.length >= max) {
        break;
      }
      const dto = mapRadioTrack(node);
      if (!dto || seen.has(dto.id)) {
        continue;
      }
      seen.add(dto.id);
      tracks.push(dto);
    }
    if (tracks.length >= max) {
      break;
    }
  }
  return { tracks, shortfall: tracks.length < target };
}

// ---------------------------------------------------------------------------
// Radio: upstream seam
// ---------------------------------------------------------------------------

export interface RadioDeps {
  fetchAutomix: (id: string) => Promise<ContinuationSearch>;
  continueAutomix: (page: ContinuationSearch) => Promise<ContinuationSearch>;
  fetchRelated: (id: string) => Promise<ContinuationSearch>;
  continueRelated: (page: ContinuationSearch) => Promise<ContinuationSearch>;
}

/** Adapts a music PlaylistPanel (getUpNext) to the continuation-page shape. */
function adaptAutomixPanel(panel: {
  contents?: { [Symbol.iterator](): Iterator<unknown> } | null;
  continuation?: string | null;
  getContinuation?: () => Promise<unknown>;
}): ContinuationSearch {
  const results = panel.contents ? [...panel.contents] : [];
  const hasMore = Boolean(
    panel.continuation && String(panel.continuation) !== "",
  );
  const getNext = panel.getContinuation;
  return {
    results,
    has_continuation: hasMore,
    getContinuation: async () => {
      if (typeof getNext !== "function") {
        throw new Error("automix_unavailable: no continuation on panel");
      }
      return adaptAutomixPanel(
        (await getNext()) as Parameters<typeof adaptAutomixPanel>[0],
      );
    },
  };
}

/** Adapts a getInfo VideoInfo to the continuation-page shape (related rail). */
function adaptWatchNext(info: {
  watch_next_feed?: { [Symbol.iterator](): Iterator<unknown> } | null;
  wn_has_continuation: boolean;
  getWatchNextContinuation: () => Promise<unknown>;
}): ContinuationSearch {
  const results = info.watch_next_feed ? [...info.watch_next_feed] : [];
  return {
    results,
    has_continuation: info.wn_has_continuation,
    getContinuation: async () =>
      adaptWatchNext(
        (await info.getWatchNextContinuation()) as Parameters<
          typeof adaptWatchNext
        >[0],
      ),
  };
}

const defaultRadioDeps: RadioDeps = {
  async fetchAutomix(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const panel = await innertube.music.getUpNext(id, true);
      return adaptAutomixPanel(
        panel as unknown as Parameters<typeof adaptAutomixPanel>[0],
      );
    }, 8000);
  },
  async continueAutomix(page) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => page.getContinuation(),
      8000,
    )) as ContinuationSearch;
  },
  async fetchRelated(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const info = await innertube.getInfo(id);
      return adaptWatchNext(
        info as unknown as Parameters<typeof adaptAutomixPanel>[0] &
          Parameters<typeof adaptWatchNext>[0],
      );
    }, 8000);
  },
  async continueRelated(page) {
    const { withTimeout } = await import("@/lib/youtube");
    return (await withTimeout(
      () => page.getContinuation(),
      8000,
    )) as ContinuationSearch;
  },
};

/** Walks a continuation chain until `need` raw nodes or exhaustion (<= 6 pages). */
async function collectRaw(
  first: ContinuationSearch,
  cont: (page: ContinuationSearch) => Promise<ContinuationSearch>,
  need: number,
): Promise<unknown[]> {
  const out: unknown[] = [...first.results];
  let page = first;
  for (let i = 0; i < 5 && out.length < need; i += 1) {
    if (!page.has_continuation) {
      break;
    }
    try {
      page = await cont(page);
    } catch {
      break;
    }
    out.push(...page.results);
  }
  return out;
}

export const RADIO_FRESH_MS = 10 * 60 * 1000;
export const RADIO_STALE_MS = 60 * 60 * 1000;

/** Wraps already-mapped DTOs as a continuation page (cursor paging below). */
function dtoPage(tracks: RadioTrackDTO[]): ContinuationSearch {
  return {
    results: tracks,
    has_continuation: false,
    getContinuation: async () => {
      throw new Error("radio_exhausted: no further pages");
    },
  };
}

export async function handleRadio(
  req: NextRequest,
  id: string,
  deps: RadioDeps = defaultRadioDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const params = req.nextUrl.searchParams;
  const region = parseRegion(params.get("region"));
  const lang = parseLang(params.get("lang"));

  if (!isAudioEnabled()) {
    return errorResponse(requestId, audioDisabledError());
  }
  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("radio"));
  }

  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return errorResponse(requestId, {
      code: "invalid_limit",
      message: "Invalid limit.",
      hint: "Use an integer between 1 and 50; defaults to 20.",
      status: 400,
    });
  }

  const scope = `radio:${id}`;
  const cursor = params.get("cursor");
  if (cursor) {
    return serveRadioCursor(requestId, region, lang, scope, cursor, limit);
  }

  try {
    // The full queue is limit-independent (assembled once, sliced per page),
    // so the L0 key is just the seed id. Fork semantics mirror related: the
    // stored source is never served directly — every caller gets a fresh
    // fork, so concurrent users never share mutable cursor state.
    const result = await cached<{
      tracks: RadioTrackDTO[];
      shortfall: boolean;
      forkFrom: string | null;
    }>(
      `radio:v1:${id}`,
      RADIO_FRESH_MS,
      async () => {
        let automixRaw: unknown[] = [];
        try {
          const first = await deps.fetchAutomix(id);
          automixRaw = await collectRaw(
            first,
            deps.continueAutomix,
            RADIO_MAX_TRACKS,
          );
        } catch {
          automixRaw = [];
        }
        let relatedRaw: unknown[] = [];
        try {
          const first = await deps.fetchRelated(id);
          relatedRaw = await collectRaw(
            first,
            deps.continueRelated,
            RADIO_MAX_TRACKS,
          );
        } catch {
          relatedRaw = [];
        }
        const { tracks, shortfall } = assembleRadioQueue(
          [automixRaw, relatedRaw],
          id,
        );
        if (tracks.length === 0) {
          throw new Error("radio_unavailable: no continuation tracks");
        }
        const forkFrom = storeContinuation(dtoPage(tracks), limit, scope);
        return { tracks, shortfall, forkFrom };
      },
      RADIO_STALE_MS,
    );
    const items = result.value.tracks.slice(0, limit);
    const next = forkContinuation(result.value.forkFrom, scope);
    const warnings: Array<{ code: string; message: string }> = [];
    if (result.stale) {
      warnings.push({
        code: "stale_served",
        message: "Upstream failed; serving a stale cached queue.",
      });
    }
    if (result.value.shortfall) {
      warnings.push({
        code: "radio_shortfall",
        message:
          "Fewer than 25 continuation tracks are available for this video.",
      });
    }
    // Cursors are process-local: a response carrying one must never sit in
    // the shared CDN. Only exhausted first pages keep the public TTL.
    return successResponse(items, {
      requestId,
      next,
      region,
      lang,
      cached: result.hit,
      warnings,
      cacheControl: next !== null ? CACHE_CONTROL.noStore : CACHE_CONTROL.radio,
    });
  } catch (err) {
    const raw =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (/radio_unavailable/.test(raw)) {
      return errorResponse(requestId, {
        code: "radio_unavailable",
        message: "No radio continuation is available for this video.",
        hint: "Try the related rail at /videos/:id/related for up-next suggestions.",
        status: 404,
      });
    }
    const classified = classifyFeedError(err);
    return errorResponse(requestId, classified);
  }
}

function serveRadioCursor(
  requestId: string,
  region: string,
  lang: string,
  scope: string,
  cursor: string,
  pageSize: number,
): NextResponse {
  const entry = takeContinuation(cursor);
  if (!entry || !hasMoreResults(entry)) {
    if (entry) {
      dropContinuation(cursor);
    }
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  if (entry.scope !== undefined && entry.scope !== scope) {
    return successResponse([], {
      requestId,
      next: null,
      region,
      lang,
      cacheControl: CACHE_CONTROL.noStore,
    });
  }
  // Queue pages are fully buffered DTOs (no upstream tail): serve this
  // entry's own slice and keep the cursor while items remain.
  const items = (entry.search.results as RadioTrackDTO[]).slice(
    entry.returned,
    entry.returned + pageSize,
  );
  entry.returned += pageSize;
  const more = hasMoreResults(entry);
  const next = more ? cursor : null;
  if (next === null) {
    dropContinuation(cursor);
  }
  return successResponse(items, {
    requestId,
    next,
    region,
    lang,
    cacheControl: CACHE_CONTROL.noStore,
  });
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export interface LyricsLineDTO {
  start?: number;
  text: string;
}

export interface LyricsDTO {
  /** Timed lines when the source provides cues, else null (plain text only). */
  lines: LyricsLineDTO[] | null;
  text: string;
}

/**
 * Maps a getLyrics shelf to a DTO. Timed cue arrays (start + text rows, when
 * served) become lines; otherwise the description text is served whole with
 * lines:null. Null = unavailable (caller answers 404).
 */
export function mapLyricsShelf(shelf: unknown): LyricsDTO | null {
  if (typeof shelf !== "object" || shelf === null) {
    return null;
  }
  const o = shelf as Record<string, unknown>;
  for (const key of ["timed_lyrics", "cues", "lyrics", "timedLyrics"]) {
    const cues = o[key];
    if (Array.isArray(cues) && cues.length > 0) {
      const lines: LyricsLineDTO[] = [];
      for (const cue of cues) {
        if (typeof cue !== "object" || cue === null) {
          continue;
        }
        const c = cue as Record<string, unknown>;
        const text = textOf(c.text) ?? textOf(c.lyric) ?? textOf(c.snippet);
        if (!text || text.trim() === "") {
          continue;
        }
        const startRaw =
          c.start ?? c.start_seconds ?? c.startSeconds ?? c.start_ms;
        const start =
          typeof startRaw === "number" && Number.isFinite(startRaw)
            ? startRaw > 1000
              ? Math.round(startRaw / 1000)
              : startRaw
            : typeof startRaw === "string" && startRaw.trim() !== ""
              ? Number(startRaw)
              : undefined;
        const line: LyricsLineDTO = { text };
        if (typeof start === "number" && Number.isFinite(start) && start >= 0) {
          line.start = start;
        }
        lines.push(line);
      }
      if (lines.length > 0) {
        return { lines, text: lines.map((l) => l.text).join("\n") };
      }
    }
  }
  const text = textOf(o.description);
  if (!text || text.trim() === "") {
    return null;
  }
  return { lines: null, text };
}

export interface LyricsDeps {
  fetchLyrics: (id: string) => Promise<LyricsDTO | null>;
}

export const defaultLyricsDeps: LyricsDeps = {
  async fetchLyrics(id) {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    return withTimeout(async () => {
      const innertube = await getInnertube();
      const shelf = await innertube.music.getLyrics(id);
      if (!shelf) {
        return null;
      }
      return mapLyricsShelf(shelf as unknown);
    }, 8000);
  },
};

export async function handleLyrics(
  req: NextRequest,
  id: string,
  deps: LyricsDeps = defaultLyricsDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const region = parseRegion(req.nextUrl.searchParams.get("region"));
  const lang = parseLang(req.nextUrl.searchParams.get("lang"));

  if (!isAudioEnabled()) {
    return errorResponse(requestId, audioDisabledError());
  }
  if (!id || !isPlausibleVideoId(id)) {
    return errorResponse(requestId, invalidVideoIdHint("lyrics"));
  }

  try {
    const result: CachedResult<LyricsDTO | null> =
      await cached<LyricsDTO | null>(
        `lyrics:v1:${id}`,
        60 * 60 * 1000, // L0 fresh window; L1 CDN carries the 3600s TTL.
        () => deps.fetchLyrics(id),
        6 * 60 * 60 * 1000, // stale window backs serve-stale-on-error.
      );
    if (result.value === null) {
      return errorResponse(requestId, {
        code: "lyrics_unavailable",
        message: "No lyrics are available for this video.",
        hint: "Lyrics are unavailable here; fall back to /videos/:id/transcript for spoken content.",
        status: 404,
      });
    }
    return successResponse(result.value, {
      requestId,
      region,
      lang,
      cached: result.hit,
      warnings: result.stale
        ? [
            {
              code: "stale_served",
              message: "Upstream failed; serving a stale cached copy.",
            },
          ]
        : [],
      cacheControl: CACHE_CONTROL.lyrics,
    });
  } catch (err) {
    return errorResponse(requestId, classifyFeedError(err));
  }
}
