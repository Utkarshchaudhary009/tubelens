// Dictionary-driven transcript provider registry (Phase 2 plan, TRANSCRIPT_PROVIDERS).
//
// Adding a provider is one dict entry — no route edits. Array order is chain
// order (the cost-zero tts-test experiment first when configured, then the
// innertube fast path, then the youtube-cli doc/plan.md:28-35 waterfall).
// Each entry declares everything the generic runner needs:
// request shape, parse mapping, lang handling, per-step budget, key, and kill
// switch. Pure fetch-based helpers (no server-only imports) stay
// unit-testable; callers inject fetchNative/fetchFn in tests.

import {
  classifyTranscriptError,
  isUpstreamTimeout,
  type TranscriptSegmentDTO,
} from "./mappers";
import {
  type ResolveFn,
  type SafeFetchFn,
  type SafeFetchResponse,
  safeFetch,
} from "./safe-fetch";

export type TranscriptProviderKind = "native" | "json" | "vtt" | "text";

export interface TranscriptProviderDef {
  /** Stable id, surfaced in the `fallback_source` warning. */
  name: string;
  /** Which shared parser runs (native dispatches to fetchNative). */
  kind: TranscriptProviderKind;
  method: "GET" | "POST";
  url: (
    id: string,
    lang: string,
    env?: Record<string, string | undefined>,
  ) => string;
  params?: (id: string, lang: string) => Record<string, string>;
  body?: (id: string, lang: string) => unknown;
  headers?: Record<string, string> | ((id: string) => Record<string, string>);
  parse: {
    segmentsPath?: string;
    textField: string;
    offsetField: string;
    durationField: string;
  };
  /** strict = mismatch fails over; best-effort = first available. */
  lang: "strict" | "best-effort";
  /** Per-provider cap, clamped to the remaining overall budget. */
  timeoutMs: number;
  /** When set, the entry is skipped if `env[apiKeyEnv]` is unset. */
  apiKeyEnv?: string;
  /**
   * When set, the entry's base URL comes from `env[baseUrlEnv]` (third `url`
   * arg); unset/empty/non-https bases skip the entry silently, same as the
   * apiKeyEnv pattern. Never a per-request Blob/tunnel read.
   */
  baseUrlEnv?: string;
  /** Raw offset/duration units; `"s"` pre-multiplies x1000 (default `"ms"`). */
  units?: "ms" | "s";
  /** Skip silently when the remaining overall budget is below this (tail). */
  minRemainingMs?: number;
  /**
   * When true, this entry never short-circuits the chain with video_not_found:
   * its 404s soften to transcript_unavailable fall-through (stale stays
   * eligible). For ephemeral helpers whose 404s describe tunnel/helper state,
   * not the video — only the native fast path may declare a video dead.
   */
  fallThrough404?: boolean;
  /** Per-provider kill switch, no route edit to flip. */
  enabled: boolean;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const watchUrl = (id: string): string =>
  `https://www.youtube.com/watch?v=${id}`;

export const TRANSCRIPT_PROVIDERS: TranscriptProviderDef[] = [
  {
    name: "tts-test",
    kind: "json",
    method: "GET",
    // Optional cost-zero experiment: base comes from TTS_TRANSCRIPT_URL
    // (validated https in the runner); unset/empty disables silently.
    // Chain head: when configured it runs before the Innertube fast path.
    // Hangs burn at most the capped 3s step (never stall the tail beyond
    // stepMs); transient 429/5xx fall through immediately with Retry-After
    // preserved, and 404s never short-circuit (fallThrough404 below).
    url: (id, lang, env) => {
      const base = ((env ?? process.env).TTS_TRANSCRIPT_URL ?? "")
        .trim()
        .replace(/\/+$/, "");
      return `${base}/transcript/${encodeURIComponent(id)}?lang=${encodeURIComponent(lang)}`;
    },
    parse: {
      segmentsPath: "transcript",
      textField: "text",
      offsetField: "start",
      durationField: "duration",
    },
    lang: "best-effort",
    timeoutMs: 3000,
    baseUrlEnv: "TTS_TRANSCRIPT_URL",
    // tts-test serves seconds floats; normalizeSegments expects ms.
    units: "s",
    // Budget floor: as chain head it always has budget, so the guard passes;
    // kept so the entry stays tail-safe if reordered later.
    minRemainingMs: 1500,
    // Ephemeral tunnel: a 404 (stale Blob URL, cold helper cache, missing
    // captions) must never short-circuit the tail or disable stale — only
    // Innertube may declare a video private/deleted.
    fallThrough404: true,
    enabled: true,
  },
  {
    name: "innertube",
    kind: "native",
    method: "GET",
    // Unused by the runner (native kind dispatches to fetchNative); present
    // so the contract holds uniformly for every entry.
    url: (id) => `native:innertube:${id}`,
    // Never read by the runner (native kind dispatches to fetchNative);
    // placeholder values only so every entry satisfies the contract.
    parse: {
      textField: "text",
      offsetField: "start_ms",
      durationField: "end_ms",
    },
    // Track-agnostic fast path: no kind/lang filtering here.
    lang: "best-effort",
    timeoutMs: 6000,
    enabled: true,
  },
  {
    name: "yttools",
    kind: "json",
    method: "GET",
    url: (id, lang) =>
      `https://yttools.co/api/transcript?url=${encodeURIComponent(watchUrl(id))}&lang=${encodeURIComponent(lang)}`,
    parse: {
      segmentsPath: "transcript",
      textField: "text",
      offsetField: "offset",
      durationField: "duration",
    },
    lang: "strict",
    timeoutMs: 5000,
    enabled: true,
  },
  {
    name: "youtube-transcript-ai",
    kind: "vtt",
    method: "GET",
    url: (id) =>
      `https://youtube-transcript.ai/api/subtitles?v=${encodeURIComponent(id)}`,
    // VTT/json3 parsing is structural (tracks -> cues), not field-mapped;
    // kept so every entry satisfies the contract.
    parse: {
      textField: "text",
      offsetField: "offset",
      durationField: "duration",
    },
    lang: "best-effort",
    timeoutMs: 6000,
    enabled: true,
  },
  {
    name: "kome",
    kind: "text",
    method: "POST",
    url: () => "https://kome.ai/api/transcript",
    body: (id) => ({ video_id: watchUrl(id), format: true }),
    headers: { origin: "https://kome.ai" },
    parse: {
      segmentsPath: "transcript",
      textField: "text",
      offsetField: "offset",
      durationField: "duration",
    },
    // Language-agnostic plain text: no lang filtering for text kind.
    lang: "best-effort",
    timeoutMs: 5000,
    enabled: true,
  },
  {
    name: "supadata",
    kind: "json",
    method: "GET",
    url: (id) =>
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(watchUrl(id))}`,
    params: (_id, lang) => ({ lang }),
    // The key itself is injected by the runner as `x-api-key` (see
    // runHttpProvider); the entry only names the env var.
    parse: {
      segmentsPath: "content",
      textField: "text",
      offsetField: "offset",
      durationField: "duration",
    },
    lang: "best-effort",
    timeoutMs: 5000,
    apiKeyEnv: "SUPADATA_API_KEY",
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Shared helpers: normalizeSegments + filterByLang run for every entry.
// ---------------------------------------------------------------------------

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Case/`_`/`-`-insensitive prefix match (`en` ~ `en-US` either way). */
export function langMatches(trackLang: string, want: string): boolean {
  const t = trackLang.trim().toLowerCase().replace(/_/g, "-");
  const w = want.trim().toLowerCase().replace(/_/g, "-");
  return t === w || t.startsWith(`${w}-`) || w.startsWith(`${t}-`);
}

type ParseMapping = Pick<
  TranscriptProviderDef["parse"],
  "textField" | "offsetField" | "durationField"
>;

/** Collapse consecutive duplicate lines (VTT repeats cues; kome repeats). */
function dedupeLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (out.length === 0 || out[out.length - 1] !== trimmed) {
      out.push(trimmed);
    }
  }
  return out.join("\n");
}

/**
 * Shared segment normalizer. Raw offsets are MILLISECONDS (yttools serves ms;
 * the VTT/json3 parsers below emit ms) and map to seconds round3. Drops empty
 * text / negative or non-finite offsets. Plain-text input (kome, fetched
 * text tracks) becomes a single zero-timestamp deduped segment.
 */
export function normalizeSegments(
  input: unknown,
  parse: ParseMapping,
): TranscriptSegmentDTO[] {
  if (typeof input === "string") {
    const text = dedupeLines(input);
    return text === "" ? [] : [{ startSeconds: 0, text }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const segments: TranscriptSegmentDTO[] = [];
  // Last emitted string item: consecutive duplicates collapse, mirroring
  // dedupeLines for plain-text input (blank items never update it, so
  // blank-separated repeats still collapse exactly like joined lines).
  let lastString = "";
  for (const item of input) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text !== "" && text !== lastString) {
        segments.push({ startSeconds: 0, text });
        lastString = text;
      }
      continue;
    }
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const rawText = o[parse.textField];
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const offsetMs = toFiniteNumber(o[parse.offsetField]);
    if (offsetMs === undefined || offsetMs < 0 || text === "") {
      continue;
    }
    const dto: TranscriptSegmentDTO = {
      startSeconds: round3(offsetMs / 1000),
      text,
    };
    const durMs = toFiniteNumber(o[parse.durationField]);
    if (durMs !== undefined && durMs > 0) {
      dto.durationSeconds = round3(durMs / 1000);
    }
    segments.push(dto);
  }
  return segments;
}

const getLangTag = (item: unknown): unknown =>
  typeof item === "object" && item !== null
    ? (item as Record<string, unknown>).lang
    : undefined;

const isUntagged = (tag: unknown): boolean =>
  tag === undefined || (typeof tag === "string" && tag.trim() === "");

/**
 * Shared language filter. Untagged/blank tags are kept (nothing to judge them
 * by); malformed non-string tags are dropped, never served as a guessed
 * language. Strict mode throws on all-tagged-but-none-match (falls through
 * to the next provider); best-effort serves matches when a tagged match
 * exists, else the whole candidate list (first-available semantics).
 */
export function filterByLang(
  items: unknown[],
  lang: string,
  mode: "strict" | "best-effort",
  getLang: (item: unknown) => unknown = getLangTag,
): unknown[] {
  // A present non-string tag is malformed: counted as tagged (never served
  // as a guessed language) and dropped here.
  const candidates = items.filter((item) => {
    const tag = getLang(item);
    return isUntagged(tag) || typeof tag === "string";
  });
  const tagMatches = (item: unknown): boolean => {
    const tag = getLang(item);
    return typeof tag === "string" && langMatches(tag, lang);
  };
  if (mode === "strict") {
    const everyItemTagged =
      candidates.length > 0 &&
      candidates.every((item) => !isUntagged(getLang(item)));
    if (everyItemTagged && !candidates.some((item) => tagMatches(item))) {
      throw new Error(
        `transcript_unavailable: language mismatch (requested ${lang})`,
      );
    }
    return candidates.filter(
      (item) => isUntagged(getLang(item)) || tagMatches(item),
    );
  }
  const hits = candidates.filter(
    (item) => isUntagged(getLang(item)) || tagMatches(item),
  );
  const anyTaggedHit = candidates.some(
    (item) => !isUntagged(getLang(item)) && tagMatches(item),
  );
  return anyTaggedHit ? hits : candidates;
}

// ---------------------------------------------------------------------------
// VTT / json3 parsers (youtube-transcript-ai tracks).
// ---------------------------------------------------------------------------

export interface RawCue {
  offsetMs: number;
  durationMs?: number;
  text: string;
}

function parseVttTimestamp(raw: string): number | undefined {
  const m = raw
    .trim()
    .replace(",", ".")
    .match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d)\.(\d{3})$/);
  if (!m) {
    return undefined;
  }
  const h = Number(m[1] ?? "0");
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4]);
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(min) ||
    !Number.isFinite(sec) ||
    !Number.isFinite(ms)
  ) {
    return undefined;
  }
  return h * 3600000 + min * 60000 + sec * 1000 + ms;
}

/** Minimal VTT cue parser: headers/NOTE blocks skipped, tags stripped. */
export function parseVtt(vtt: string): RawCue[] {
  const cues: RawCue[] = [];
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  let lastText = "";
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length === 0) {
      continue;
    }
    const first = lines[0] ?? "";
    if (/^WEBVTT/i.test(first) || /^NOTE/i.test(first)) {
      continue;
    }
    const arrow = lines.findIndex((l) => l.includes("-->"));
    if (arrow === -1) {
      continue;
    }
    const [startRaw, endRaw] = (lines[arrow] ?? "").split("-->");
    const startMs = parseVttTimestamp(startRaw ?? "");
    const endMs = parseVttTimestamp(endRaw ?? "");
    if (startMs === undefined || startMs < 0) {
      continue;
    }
    const text = dedupeLines(
      lines
        .slice(arrow + 1)
        .map((l) =>
          l
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/g, " ")
            .trim(),
        )
        .filter((l) => l !== "")
        .join("\n"),
    );
    // VTT repeats the running cue on consecutive blocks; emit each text once.
    if (text === "" || text === lastText) {
      continue;
    }
    lastText = text;
    const cue: RawCue = { offsetMs: startMs, text };
    if (endMs !== undefined && endMs > startMs) {
      cue.durationMs = endMs - startMs;
    }
    cues.push(cue);
  }
  return cues;
}

/**
 * YouTube json3 parser (`{events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}`).
 * Header events carry no segs and are dropped.
 */
export function parseJson3(json: unknown): RawCue[] {
  if (typeof json !== "object" || json === null) {
    return [];
  }
  const events = (json as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    return [];
  }
  const cues: RawCue[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const e = event as Record<string, unknown>;
    const offsetMs = toFiniteNumber(e.tStartMs);
    if (offsetMs === undefined || offsetMs < 0) {
      continue;
    }
    const segs = e.segs;
    const text = Array.isArray(segs)
      ? dedupeLines(
          segs
            .map((s) =>
              typeof s === "object" &&
              s !== null &&
              typeof (s as Record<string, unknown>).utf8 === "string"
                ? ((s as Record<string, unknown>).utf8 as string).replace(
                    /\n/g,
                    " ",
                  )
                : "",
            )
            .join("")
            .trim(),
        )
      : "";
    if (text === "") {
      continue;
    }
    const cue: RawCue = { offsetMs, text };
    const durMs = toFiniteNumber(e.dDurationMs);
    if (durMs !== undefined && durMs > 0) {
      cue.durationMs = durMs;
    }
    cues.push(cue);
  }
  return cues;
}

function rawCuesToSegments(cues: RawCue[]): TranscriptSegmentDTO[] {
  return normalizeSegments(
    cues.map((c) => ({
      text: c.text,
      offset: c.offsetMs,
      duration: c.durationMs,
    })),
    { textField: "text", offsetField: "offset", durationField: "duration" },
  );
}

// ---------------------------------------------------------------------------
// Generic runner: ordered waterfall over TRANSCRIPT_PROVIDERS.
// ---------------------------------------------------------------------------

export interface TranscriptRunnerDeps {
  fetchNative: (
    id: string,
    signal: AbortSignal,
  ) => Promise<TranscriptSegmentDTO[]>;
  /** Omit to disable HTTP providers (unit-test/offline mode). */
  fetchFn?: FetchLike;
  /** DNS pinning for provider + track-follow-up fetches (safeFetch).
   * `undefined` (default) falls through to safeFetch's node:dns pinning —
   * the production route passes `dnsResolve` explicitly. Tests with injected
   * transports pass the documented `null` skip sentinel to stay
   * offline-deterministic under bun:test. */
  resolveFn?: ResolveFn | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Single overall fail-fast budget; per-provider caps clamp to remaining. */
  budgetMs?: number;
  /** Override the chain (tests); defaults to TRANSCRIPT_PROVIDERS. */
  providers?: TranscriptProviderDef[];
}

export interface TranscriptWaterfallResult {
  segments: TranscriptSegmentDTO[];
  /** Absent = Innertube fast path (no fallback_source warning). */
  provider?: string;
}

/** Definitive 404s only on video-scoped wording — never bare provider 4xx. */
const VIDEO_SCOPED =
  /video.{0,40}(private|deleted|removed|unavailable|not found)|(private|deleted|removed|unavailable|not found).{0,40}video/i;

/** Transient upstreams keep their status (never transcript_unavailable). */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Status-preserving provider HTTP error: the classifier maps the carried
 * `status` (429 -> rate_limited with Retry-After, 5xx -> 502
 * upstream_degraded) instead of a misleading 404 transcript_unavailable.
 */
function httpError(name: string, status: number, retryAfter?: number): Error {
  const err = new Error(`${name} upstream responded with status ${status}`);
  (err as { status?: number }).status = status;
  if (retryAfter !== undefined) {
    (err as { retryAfter?: number }).retryAfter = retryAfter;
  }
  return err;
}

/** Upstream Retry-After seconds when the response carries a parseable one. */
function retryAfterOf(
  res: SafeFetchResponse | Awaited<ReturnType<FetchLike>>,
): number | undefined {
  const headers = (res as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") {
    return undefined;
  }
  try {
    const raw = (get as (name: string) => unknown).call(headers, "retry-after");
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim();
    // Empty/blank carries no delay: fall through to the 60s default
    // (Number("") is 0, which must never become retry-immediately).
    if (trimmed === "") {
      return undefined;
    }
    const delay = Number(trimmed);
    if (Number.isFinite(delay) && delay >= 0) {
      return Math.round(delay);
    }
    // Otherwise an HTTP-date: remaining whole seconds until then, clamped
    // at 0 (a past date is retry-now, not a negative header). Ceiling, not
    // rounding: a fractional remainder must never advertise a retry time
    // before the date the upstream named.
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when)) {
      return Math.max(0, Math.ceil((when - Date.now()) / 1000));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shared !ok mapping for provider and follow-up track fetches. A definitive
 * video_not_found short-circuits only on video-scoped wording over a
 * definitive client error (4xx other than 429) — transient bodies never do,
 * even when they mention the video, so fallback and stale keep working.
 */
function throwForHttpStatus(
  name: string,
  status: number,
  detail: string,
  retryAfter?: number,
): never {
  if (
    !isTransientStatus(status) &&
    status >= 400 &&
    status < 500 &&
    VIDEO_SCOPED.test(detail)
  ) {
    throw new Error(
      `video_not_found: ${name} reports this video is unavailable (status ${status})`,
    );
  }
  if (isTransientStatus(status)) {
    throw httpError(name, status, retryAfter);
  }
  throw new Error(`transcript_unavailable: ${name} returned HTTP ${status}`);
}

/** Registry-wide SSRF pin for the HTTP providers (mirrors every `url()`
 * entry below; extend it when a provider host is added or retired). The
 * `.trycloudflare.com` suffix covers the tts-test experiment's dynamic
 * tunnel host; a new entry's own host is additionally pinned per-request
 * (providerPin), so the chain enforces the boundary before this list is
 * extended. */
export const TRANSCRIPT_PROVIDER_HOSTS = [
  "yttools.co",
  "youtube-transcript.ai",
  "kome.ai",
  "api.supadata.ai",
  ".trycloudflare.com",
];

/**
 * The listing fetch's own declared host (a code constant per dict entry).
 * Pinned strictly per-request at the call site — the first hop must match
 * the entry's own host, and redirect hops re-validate against the same pin;
 * TRANSCRIPT_PROVIDER_HOSTS is only the fallback when the endpoint is
 * unparseable (checkUrl rejects those first). A new entry still needs no
 * route edit: its first hop is pinned to its own host automatically.
 */
function providerPin(endpoint: string): string[] {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "" ? [] : [host];
  } catch {
    return [];
  }
}

/** True only for absolute https bases (experiment env pointers). */
function isHttpsBase(base: string): boolean {
  try {
    const u = new URL(base.trim());
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Seconds-unit providers (tts-test serves seconds floats) scaled to the ms
 * shape normalizeSegments expects. Non-object items pass through; non-finite
 * fields keep their raw value so the normalizer drops them as usual.
 */
function scaleSecondsToMs(items: unknown[], parse: ParseMapping): unknown[] {
  return items.map((item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }
    const o = item as Record<string, unknown>;
    const out = { ...o };
    for (const f of [parse.offsetField, parse.durationField]) {
      const n = toFiniteNumber(o[f]);
      if (n !== undefined) {
        out[f] = n * 1000;
      }
    }
    return out;
  });
}

/**
 * Adapts an injected FetchLike transport to the safeFetch transport shape.
 * Real Response headers are preserved when present (production global fetch)
 * so redirect Locations stay visible to the boundary; header-less test
 * doubles read as "no Location" (no redirect hop is simulated).
 */
function adaptFetchLike(fetchFn: FetchLike): SafeFetchFn {
  return async (input: string, init?: RequestInit) => {
    const res = await fetchFn(input, init);
    const headersOf = (
      res as unknown as {
        headers?: { get(name: string): string | null };
      }
    ).headers;
    return {
      ok: res.ok,
      status: res.status,
      headers: { get: (name: string) => headersOf?.get(name) ?? null },
      arrayBuffer: async () =>
        new TextEncoder().encode(await res.text()).buffer as ArrayBuffer,
      json: () => res.json(),
      text: () => res.text(),
    };
  };
}

/** kome's "transcripts aren't available" apology: rejected, never emitted. */
const KOME_APOLOGY =
  /transcripts?\s+(are|is)n'?t\s+available|no\s+transcript\s+available|transcript.{0,60}(unavailable|disabled)|sorry.{0,40}transcript/i;

function getPath(obj: unknown, path?: string): unknown {
  if (!path || typeof obj !== "object" || obj === null) {
    return undefined;
  }
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** First shape that resolves wins (configured path, then common aliases). */
function getSegmentsPayload(json: unknown, segmentsPath?: string): unknown {
  const direct = getPath(json, segmentsPath);
  if (Array.isArray(direct) || typeof direct === "string") {
    return direct;
  }
  for (const alt of ["transcript", "content", "segments", "data"]) {
    if (alt === segmentsPath) {
      continue;
    }
    const v = getPath(json, alt);
    if (Array.isArray(v) || typeof v === "string") {
      return v;
    }
  }
  return undefined;
}

function getTracksPayload(json: unknown): unknown[] {
  if (Array.isArray(json)) {
    return json;
  }
  for (const key of ["tracks", "subtitles", "captions", "data"]) {
    const v = getPath(json, key);
    if (Array.isArray(v)) {
      return v;
    }
  }
  return [];
}

function trackLangOf(track: unknown): string | undefined {
  if (typeof track !== "object" || track === null) {
    return undefined;
  }
  const t = track as Record<string, unknown>;
  for (const key of ["lang", "language", "code", "languageCode"]) {
    const v = t[key];
    if (typeof v === "string" && v.trim() !== "") {
      return v;
    }
  }
  return undefined;
}

/**
 * Raw language tag (any type): distinguishes untagged (absent) from
 * malformed (present but non-string). Malformed tags are dropped before
 * track selection, never served as a guessed language.
 */
function trackTagOf(track: unknown): unknown {
  if (typeof track !== "object" || track === null) {
    return undefined;
  }
  const t = track as Record<string, unknown>;
  for (const key of ["lang", "language", "code", "languageCode"]) {
    const v = t[key];
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
}

/**
 * Resolve a provider-listed track URL against the listing endpoint. Same
 * origin + https only: the follow-up fetch is server-side, so an arbitrary
 * third-party URL (compromised listing, odd CDN) is rejected as a provider
 * failure and the chain falls through — never fetched, never a 500.
 */
function resolveTrackUrl(
  name: string,
  trackUrl: string,
  endpoint: string,
): string {
  let absolute: URL;
  let base: URL;
  try {
    absolute = new URL(trackUrl, endpoint);
    base = new URL(endpoint);
  } catch {
    throw new Error(
      `transcript_unavailable: ${name} returned an unexpected response shape`,
    );
  }
  if (absolute.protocol !== "https:" || absolute.hostname !== base.hostname) {
    throw new Error(
      `transcript_unavailable: ${name} returned an unexpected response shape`,
    );
  }
  return absolute.toString();
}

function trackContentOf(track: unknown): string | undefined {
  if (typeof track !== "object" || track === null) {
    return undefined;
  }
  const v = (track as Record<string, unknown>).vttContent;
  return typeof v === "string" && v !== "" ? v : undefined;
}

function trackUrlOf(track: unknown): string | undefined {
  if (typeof track !== "object" || track === null) {
    return undefined;
  }
  const t = track as Record<string, unknown>;
  for (const key of ["vttUrl", "json3Url"]) {
    const v = t[key];
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  return undefined;
}

async function runNativeProvider(
  id: string,
  stepMs: number,
  deps: TranscriptRunnerDeps,
): Promise<TranscriptSegmentDTO[]> {
  const signal = AbortSignal.timeout(stepMs);
  return deps.fetchNative(id, signal);
}

async function runHttpProvider(
  def: TranscriptProviderDef,
  id: string,
  lang: string,
  stepMs: number,
  deps: TranscriptRunnerDeps,
  env: Record<string, string | undefined>,
): Promise<TranscriptSegmentDTO[]> {
  const fetchFn = deps.fetchFn;
  // No HTTP client injected (unit-test/offline mode): skip silently.
  if (!fetchFn) {
    return [];
  }
  // Provider-level start: the VTT follow-up track fetch below clamps to the
  // remaining step budget (never a fresh full timeout on top of the first).
  const nowFn = deps.now ?? Date.now;
  const stepStarted = nowFn();
  let endpoint = def.url(id, lang, env);
  if (def.params) {
    try {
      const u = new URL(endpoint);
      for (const [k, v] of Object.entries(def.params(id, lang))) {
        u.searchParams.set(k, v);
      }
      endpoint = u.toString();
    } catch {
      const extra = new URLSearchParams(def.params(id, lang)).toString();
      endpoint += `${endpoint.includes("?") ? "&" : "?"}${extra}`;
    }
  }
  const headers: Record<string, string> = { accept: "*/*" };
  const declared =
    typeof def.headers === "function" ? def.headers(id) : (def.headers ?? {});
  for (const [k, v] of Object.entries(declared)) {
    headers[k] = v;
  }
  // apiKeyEnv entries authenticate as `x-api-key` (supadata); the entry only
  // names the env var, the runner injects the secret — never logged.
  if (
    def.apiKeyEnv &&
    env[def.apiKeyEnv] &&
    headers["x-api-key"] === undefined
  ) {
    headers["x-api-key"] = env[def.apiKeyEnv] as string;
  }
  let rawBody: string | undefined;
  if (def.body) {
    rawBody = JSON.stringify(def.body(id, lang));
    if (headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
  }
  // Network/abort errors propagate as-is (timeouts classify 504 and stay
  // stale-eligible via the route's predicate). The fetch runs through the
  // SSRF boundary pinned to the entry's own declared host (same 8s-clamped
  // step budget) — a compromised listing cannot redirect the request
  // off-host, not even laterally to another provider, and SsrfBlockedError
  // simply fails over to the next provider. `undefined` resolveFn falls
  // through to safeFetch's default node:dns pinning (production); tests
  // pass the documented `null` skip sentinel.
  const pin = providerPin(endpoint);
  const res = await safeFetch(endpoint, {
    allowHosts: pin.length > 0 ? pin : TRANSCRIPT_PROVIDER_HOSTS,
    timeoutMs: stepMs,
    // Absolute step deadline: safeFetch composes it with the per-hop
    // timeout, so a redirect chain cannot re-spend stepMs per hop and
    // overrun the waterfall budget.
    signal: AbortSignal.timeout(stepMs),
    method: def.method,
    headers,
    body: rawBody,
    fetchFn: adaptFetchLike(fetchFn),
    resolveFn: deps.resolveFn,
  });
  if (!res.ok) {
    // A bare 4xx is transcript-scoped (never video_not_found): only
    // video-scoped wording over a definitive 4xx short-circuits the chain
    // (and skips stale); transient 429/5xx keep their status and fall
    // through to the next provider.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
    throwForHttpStatus(def.name, res.status, detail, retryAfterOf(res));
  }
  if (def.kind === "vtt") {
    // Remaining step budget for the follow-up track fetch: the first fetch
    // already spent (now - stepStarted), so the second clamps to min(stepMs,
    // remaining) — never stacked full budgets against the overall deadline.
    const remainingStepMs = () => Math.max(1, stepMs - (nowFn() - stepStarted));
    return runVttPayload(
      def,
      res,
      endpoint,
      lang,
      remainingStepMs,
      fetchFn,
      deps.resolveFn,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(
      `transcript_unavailable: ${def.name} returned an unexpected response shape`,
    );
  }
  if (def.kind === "text") {
    return runTextPayload(def, json);
  }
  const payload = getSegmentsPayload(json, def.parse.segmentsPath);
  if (typeof payload === "string") {
    return normalizeSegments(payload, def.parse);
  }
  if (!Array.isArray(payload)) {
    throw new Error(
      `transcript_unavailable: ${def.name} returned an unexpected response shape`,
    );
  }
  // Strict mismatch throws (falls through); best-effort keeps first-available.
  const filtered = filterByLang(payload, lang, def.lang);
  const segments = normalizeSegments(
    def.units === "s" ? scaleSecondsToMs(filtered, def.parse) : filtered,
    def.parse,
  );
  if (segments.length === 0) {
    throw new Error(
      `transcript_unavailable: ${def.name} returned no transcript segments`,
    );
  }
  return segments;
}

async function runVttPayload(
  def: TranscriptProviderDef,
  res: SafeFetchResponse,
  endpoint: string,
  lang: string,
  remainingStepMs: () => number,
  fetchFn: FetchLike,
  resolveFn?: ((hostname: string) => Promise<string[]>) | null,
): Promise<TranscriptSegmentDTO[]> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(
      `transcript_unavailable: ${def.name} returned an unexpected response shape`,
    );
  }
  const tracks = getTracksPayload(json);
  if (tracks.length === 0) {
    throw new Error(
      `transcript_unavailable: ${def.name} returned no transcript segments`,
    );
  }
  // Best-effort track selection: the requested language track when tagged,
  // else the first available track (untagged tracks keep their order).
  // Malformed non-string tags are dropped first (mirroring filterByLang);
  // when nothing well-formed remains the provider counts as empty.
  const usable = tracks.filter((t) => {
    const tag = trackTagOf(t);
    return tag === undefined || typeof tag === "string";
  });
  if (usable.length === 0) {
    throw new Error(
      `transcript_unavailable: ${def.name} returned no transcript segments`,
    );
  }
  const tagged = usable.filter((t) => trackLangOf(t) !== undefined);
  const match = tagged.find((t) => langMatches(trackLangOf(t) as string, lang));
  const selected = match ?? usable[0];
  const inline = trackContentOf(selected);
  let cues: RawCue[];
  if (inline !== undefined) {
    cues = parseVtt(inline);
  } else {
    const trackUrl = trackUrlOf(selected);
    if (!trackUrl) {
      throw new Error(
        `transcript_unavailable: ${def.name} returned no transcript segments`,
      );
    }
    const absolute = resolveTrackUrl(def.name, trackUrl, endpoint);
    // Same-host re-validation through the SSRF boundary: pinned to the
    // listing host (resolveTrackUrl above already enforced same-host +
    // https), so redirect escapes and literal-IP tricks in the track URL
    // throw instead of fetching.
    let listingHosts: (string | RegExp)[];
    try {
      listingHosts = [new URL(endpoint).hostname.toLowerCase()];
    } catch {
      listingHosts = TRANSCRIPT_PROVIDER_HOSTS;
    }
    // Remaining step budget as BOTH the per-hop timeout and the absolute
    // signal (same bounding rationale as the listing call above).
    const trackBudget = remainingStepMs();
    const trackRes = await safeFetch(absolute, {
      allowHosts: listingHosts,
      timeoutMs: trackBudget,
      signal: AbortSignal.timeout(trackBudget),
      fetchFn: adaptFetchLike(fetchFn),
      resolveFn,
    });
    if (!trackRes.ok) {
      let detail = "";
      try {
        detail = await trackRes.text();
      } catch {
        detail = "";
      }
      throwForHttpStatus(
        def.name,
        trackRes.status,
        detail,
        retryAfterOf(trackRes),
      );
    }
    const body = await trackRes.text();
    const trimmed = body.trimStart();
    if (/^WEBVTT/i.test(trimmed)) {
      cues = parseVtt(body);
    } else if (/^\s*[{[]/.test(trimmed)) {
      try {
        cues = parseJson3(JSON.parse(body) as unknown);
      } catch {
        throw new Error(
          `transcript_unavailable: ${def.name} returned an unexpected response shape`,
        );
      }
    } else {
      // Plain-text track body: single deduped segment, never an error.
      const segments = normalizeSegments(body, def.parse);
      if (segments.length === 0) {
        throw new Error(
          `transcript_unavailable: ${def.name} returned no transcript segments`,
        );
      }
      return segments;
    }
  }
  const segments = rawCuesToSegments(cues);
  if (segments.length === 0) {
    throw new Error(
      `transcript_unavailable: ${def.name} returned no transcript segments`,
    );
  }
  return segments;
}

/**
 * Transient provider failures (carried 429/5xx status, timeouts/aborts):
 * "retry later", never a definitive "no transcript".
 */
function isTransientError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const status = (err as Record<string, unknown>).status;
    if (typeof status === "number" && isTransientStatus(status)) {
      return true;
    }
  }
  return isUpstreamTimeout(err);
}

/**
 * First non-empty success wins; empty / language-mismatch / apology-text
 * counts as failure and falls through. Disabled or key-missing entries are
 * skipped silently. A definitive video_not_found short-circuits (never stale).
 * On total failure the first transient error wins over earlier
 * transcript-scoped ones (a rate-limit/outage means "retry", never a
 * misleading 404); otherwise the first error stands.
 */
export async function runTranscriptWaterfall(
  id: string,
  lang: string,
  deps: TranscriptRunnerDeps,
): Promise<TranscriptWaterfallResult> {
  const providers = deps.providers ?? TRANSCRIPT_PROVIDERS;
  const budgetMs = deps.budgetMs ?? 8000;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const started = now();
  let firstErr: unknown = null;
  let firstTransientErr: unknown = null;
  for (const def of providers) {
    if (!def.enabled) {
      continue;
    }
    if (def.apiKeyEnv && !env[def.apiKeyEnv]) {
      continue;
    }
    // Base-URL experiments (tts-test) are disabled by default: unset, empty,
    // or non-https bases skip silently — never a fetch, never a 500.
    if (def.baseUrlEnv) {
      const base = (env[def.baseUrlEnv] ?? "").trim();
      if (base === "" || !isHttpsBase(base)) {
        continue;
      }
    }
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) {
      const err = new Error(`Upstream timed out after ${budgetMs}ms`);
      err.name = "TimeoutError";
      firstErr ??= err;
      firstTransientErr ??= err;
      break;
    }
    // Budget floor: entries with a floor (tts-test) yield when the
    // remaining overall budget is too thin for a useful attempt.
    if (def.minRemainingMs !== undefined && remaining < def.minRemainingMs) {
      continue;
    }
    const stepMs = Math.min(def.timeoutMs, remaining);
    try {
      const segments =
        def.kind === "native"
          ? await runNativeProvider(id, stepMs, deps)
          : await runHttpProvider(def, id, lang, stepMs, deps, env);
      if (segments.length > 0) {
        return def.kind === "native"
          ? { segments }
          : { segments, provider: def.name };
      }
      firstErr ??= new Error(
        `transcript_unavailable: ${def.name} returned no transcript segments`,
      );
    } catch (err) {
      // No provider can resurrect a private/deleted video — short-circuit and
      // (via the route's predicate) never serve stale for it. Ephemeral
      // helpers (fallThrough404) never make that call: their 404s describe
      // tunnel/helper state, so they soften to transcript_unavailable and the
      // chain falls through with stale still eligible.
      if (classifyTranscriptError(err).code === "video_not_found") {
        if (!def.fallThrough404) {
          throw err;
        }
        firstErr ??= new Error(
          `transcript_unavailable: ${def.name} reported this video as unavailable`,
        );
        continue;
      }
      firstErr ??= err;
      if (isTransientError(err)) {
        firstTransientErr ??= err;
      }
    }
  }
  if (firstTransientErr) {
    throw firstTransientErr;
  }
  if (firstErr) {
    throw firstErr;
  }
  throw new Error("transcript_unavailable: all transcript providers empty");
}

function runTextPayload(
  def: TranscriptProviderDef,
  json: unknown,
): TranscriptSegmentDTO[] {
  const payload = getSegmentsPayload(json, def.parse.segmentsPath);
  const text =
    typeof payload === "string"
      ? payload
      : Array.isArray(payload)
        ? payload
            .map((item) => {
              if (typeof item === "string") {
                return item;
              }
              if (typeof item === "object" && item !== null) {
                const v = (item as Record<string, unknown>)[
                  def.parse.textField
                ];
                return typeof v === "string" ? v : "";
              }
              return "";
            })
            .join("\n")
        : "";
  if (text.trim() === "") {
    throw new Error(
      `transcript_unavailable: ${def.name} returned no transcript segments`,
    );
  }
  // Provider apologies ("transcripts aren't available") are rejected, never
  // emitted as content — the chain falls through to the next provider.
  if (KOME_APOLOGY.test(text)) {
    throw new Error(
      `transcript_unavailable: ${def.name} has no transcript for this video`,
    );
  }
  return normalizeSegments(text, def.parse);
}
