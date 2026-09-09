import { z } from "zod";

// Shared query validation. limit/region/lang defaults per DX_PRINCIPLES.md:
// limit default 20 / max 50, region US, lang en.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

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
