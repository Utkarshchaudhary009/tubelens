import { z } from "zod";

// Shared query validation. limit/region/lang defaults per DX_PRINCIPLES.md:
// limit default 20 / max 50, region US, lang en.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

// Part B Phase 08 — centralized input bounds. Query, cursor, URL, and body
// sizes are capped here so every route rejects oversized input BEFORE any
// cache lookup or upstream call (unbounded work is the abuse vector).
// Clamps/fallbacks elsewhere in this file (parseLimit, parseRegion,
// parseLang) stay as-is — turning them into 400s would be a breaking change.
export const MAX_Q_LENGTH = 200;
export const MAX_CURSOR_LENGTH = 2048;
export const MAX_URL_LENGTH = 4000;
export const MAX_BODY_BYTES = 100_000;

export const searchTypeSchema = z.enum(["video", "channel", "playlist", "all"]);
export type SearchType = z.infer<typeof searchTypeSchema>;

/**
 * Parses `limit`: missing/empty -> default 20; integer -> clamped to
 * [1, 50]; anything else -> null (caller returns 400 invalid_limit).
 */
export function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_LIMIT;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    return null;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(n)) {
    return null;
  }
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** Two-letter region, uppercased; falls back to US when absent/invalid. */
export function parseRegion(raw: string | null): string {
  const v = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : "US";
}

/** Two-letter language, lowercased; falls back to en when absent/invalid. */
export function parseLang(raw: string | null): string {
  const v = (raw ?? "").trim().toLowerCase();
  return /^[a-z]{2}$/.test(v) ? v : "en";
}

/** 11-char-ish YouTube video id; broader lengths allowed, garbage rejected. */
export function isPlausibleVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{5,64}$/.test(id);
}

export interface ParsedSearchParams {
  q: string;
  type: SearchType;
  limit: number;
  region: string;
  lang: string;
}

export interface SearchParamsError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export interface SuggestionsParams {
  q: string;
  limit: number;
  region: string;
  lang: string;
}

export type SuggestionsParamsResult =
  | { ok: true; value: SuggestionsParams }
  | { ok: false; error: SearchParamsError };

/**
 * Pure validation for /api/v1/search/suggestions query params (kept in lib
 * so it is unit-testable without importing the route's youtubei singleton).
 * Missing q reuses the search missing_query shape; limit via parseLimit.
 */
export function parseSuggestionsParams(
  params: URLSearchParams,
): SuggestionsParamsResult {
  const q = (params.get("q") ?? "").trim();
  if (!q) {
    return {
      ok: false,
      error: {
        code: "missing_query",
        message: "Query parameter q is required.",
        hint: "Add ?q= to your request, e.g. /api/v1/search/suggestions?q=lofi.",
        status: 400,
      },
    };
  }
  const bounded = parseBoundedQuery(q);
  if (!bounded.ok) {
    return bounded;
  }
  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return {
      ok: false,
      error: {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50; defaults to 20.",
        status: 400,
      },
    };
  }
  return {
    ok: true,
    value: {
      q,
      limit,
      region: parseRegion(params.get("region")),
      lang: parseLang(params.get("lang")),
    },
  };
}

export type HashtagTagResult =
  | { ok: true; value: string }
  | { ok: false; error: SearchParamsError };

/**
 * Pure validation for /api/v1/hashtags/:tag path params. Strips one leading
 * `#` (so `%23lofi` and `lofi` agree), then requires 1-64 letters, digits,
 * underscores, or hyphens (unicode-aware, so real-world tags like `lo-fi`
 * or non-ASCII tags pass). Slashes, dots, spaces, and `%` stay rejected, so
 * the tag is safe to embed in cache keys, scopes, and the youtubei call.
 */
export function parseHashtagTag(raw: string): HashtagTagResult {
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[\p{L}\p{M}\p{N}_-]{1,64}$/u.test(stripped)) {
    return {
      ok: false,
      error: {
        code: "invalid_hashtag",
        message: "Invalid hashtag.",
        hint: "Use 1-64 letters, digits, underscores, or hyphens, e.g. /api/v1/hashtags/lo-fi.",
        status: 400,
      },
    };
  }
  return { ok: true, value: stripped };
}

export type SearchParamsResult =
  | { ok: true; value: ParsedSearchParams }
  | { ok: false; error: SearchParamsError };

/**
 * Pure validation for /api/v1/search query params (kept in lib so it is
 * unit-testable without importing the route's youtubei singleton).
 */
export function parseSearchParams(params: URLSearchParams): SearchParamsResult {
  const q = (params.get("q") ?? "").trim();
  if (!q) {
    return {
      ok: false,
      error: {
        code: "missing_query",
        message: "Query parameter q is required.",
        hint: "Add ?q= to your request, e.g. /api/v1/search?q=lofi.",
        status: 400,
      },
    };
  }
  const bounded = parseBoundedQuery(q);
  if (!bounded.ok) {
    return bounded;
  }
  const typeRaw = params.get("type") ?? "all";
  const typeParsed = searchTypeSchema.safeParse(typeRaw);
  if (!typeParsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_type",
        message: `Invalid type "${typeRaw}".`,
        hint: "Use one of: video, channel, playlist, all.",
        status: 400,
      },
    };
  }
  const limit = parseLimit(params.get("limit"));
  if (limit === null) {
    return {
      ok: false,
      error: {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50; defaults to 20.",
        status: 400,
      },
    };
  }
  return {
    ok: true,
    value: {
      q,
      type: typeParsed.data,
      limit,
      region: parseRegion(params.get("region")),
      lang: parseLang(params.get("lang")),
    },
  };
}

// ---------------------------------------------------------------------------
// Part B Phase 08 — bounded query/cursor/url/body validation.
// Small pure helpers (plus one bounded body reader) shared by every route.
// Over-length input is a typed 400 BEFORE any cache/upstream work, so rejected
// requests never trigger unbounded reads, giant cache keys, or upstream calls.
// ---------------------------------------------------------------------------

export type BoundedQueryResult =
  | { ok: true; value: string }
  | { ok: false; error: SearchParamsError };

/** Already-trimmed q over MAX_Q_LENGTH chars is a 400 invalid_query. */
export function parseBoundedQuery(q: string): BoundedQueryResult {
  if (q.length > MAX_Q_LENGTH) {
    return {
      ok: false,
      error: {
        code: "invalid_query",
        message: "Query is too long.",
        hint: "Keep q to 200 characters or fewer.",
        status: 400,
      },
    };
  }
  return { ok: true, value: q };
}

export type BoundedCursorResult =
  | { ok: true; value: string | null }
  | { ok: false; error: SearchParamsError };

/**
 * Absent/empty cursor -> ok(null) (callers treat it as "first page", exactly
 * like today's `if (cursor)` branches). A present cursor over
 * MAX_CURSOR_LENGTH chars is a 400 invalid_cursor — unknown/expired cursors
 * still degrade to an empty page, never an error.
 */
export function parseBoundedCursor(raw: string | null): BoundedCursorResult {
  if (raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (raw.length > MAX_CURSOR_LENGTH) {
    return {
      ok: false,
      error: {
        code: "invalid_cursor",
        message: "Cursor is too long.",
        hint: "Cursors are opaque strings up to 2048 characters; re-run the original query to mint a fresh cursor.",
        status: 400,
      },
    };
  }
  return { ok: true, value: raw };
}

export type BoundedUrlResult =
  | { ok: true; value: string }
  | { ok: false; error: SearchParamsError };

/**
 * Raw `url` over MAX_URL_LENGTH chars is a 400 invalid_url. Emptiness stays
 * the route's own missing_url check — this helper only bounds length.
 */
export function parseBoundedUrl(url: string): BoundedUrlResult {
  if (url.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      error: {
        code: "invalid_url",
        message: "URL is too long.",
        hint: "Keep url to 4000 characters or fewer.",
        status: 400,
      },
    };
  }
  return { ok: true, value: url };
}

function bodyTooLargeError(): SearchParamsError {
  return {
    code: "body_too_large",
    message: "Request body is too large.",
    hint: "Keep request bodies to 100,000 bytes or fewer.",
    status: 413,
  };
}

function invalidJsonBodyError(): SearchParamsError {
  return {
    code: "invalid_body",
    message: "Request body must be valid JSON.",
    hint: "Send a JSON object with Content-Type: application/json.",
    status: 400,
  };
}

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SearchParamsError };

export interface BoundedJsonOptions {
  /**
   * Value to return when the body is empty/whitespace-only. When omitted,
   * empty bodies are a 400 invalid_body (endpoints with required bodies).
   * The key-revoke endpoint passes `{}` so a bare POST revokes without a
   * reason — its long-standing contract.
   */
  emptyValue?: unknown;
}

/**
 * Bounded replacement for unbounded `req.json()`. Pre-checks the
 * Content-Length header when present (413 without reading the stream;
 * unparseable/negative values are treated as absent), else streams the body
 * through a reader with a running UTF-8 byte counter — the reader is
 * cancelled the moment the cap is exceeded, so a spoofed small/absent
 * Content-Length can never force full allocation of a huge body. Bytes (not
 * UTF-16 code units) are counted so multibyte chars cannot smuggle past the
 * cap. A null body counts as empty. The joined text then JSON.parses in
 * try/catch (400 invalid_body when malformed). The 413 shape passes straight
 * to `errorResponse()`; non-413 failures let each call site map to its legacy
 * code (batch keeps invalid_batch, admin/tunnel keep invalid_body with their
 * own hints).
 */
export async function readBoundedJson(
  req: Request,
  opts?: BoundedJsonOptions,
): Promise<BoundedJsonResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared.trim(), 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return { ok: false, error: bodyTooLargeError() };
    }
  }
  if (req.body === null) {
    if (opts !== undefined && "emptyValue" in opts) {
      return { ok: true, value: opts.emptyValue };
    }
    return { ok: false, error: invalidJsonBodyError() };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      seen += value.byteLength;
      if (seen > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, error: bodyTooLargeError() };
      }
      chunks.push(value);
    }
  } catch {
    // A stream error mid-read is malformed input, same as a JSON.parse
    // failure below — a typed 400, never a bare 500.
    return { ok: false, error: invalidJsonBodyError() };
  } finally {
    reader.releaseLock();
  }
  // Joined once so multibyte sequences split across chunks still decode.
  const merged = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.trim() === "") {
    if (opts !== undefined && "emptyValue" in opts) {
      return { ok: true, value: opts.emptyValue };
    }
    return { ok: false, error: invalidJsonBodyError() };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: invalidJsonBodyError() };
  }
}
