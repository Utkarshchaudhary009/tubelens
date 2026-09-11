// yttools.co transcript fallback for /api/v1/videos/:id/transcript.
//
// Innertube getTranscript() returns 400/empty from server IPs (datacenter
// gating, verified 2026-09-06; upstream LuanRT/YouTube.js#1099), so the route
// keeps it as a fast path and falls back to yttools.co on failure:
//   GET https://yttools.co/api/transcript?url=<watch url>&lang=<lang>
//   -> {transcript: [{text, offset(ms), duration(ms), lang}]}
// (youtube-cli doc/plan.md Phase 1, step 1; more providers later.)
//
// Pure fetch-based helper (no server-only imports) so it stays
// unit-testable; callers inject a fetch implementation in tests.

import type { TranscriptSegmentDTO } from "./mappers";

export interface TranscriptFallbackResult {
  segments: TranscriptSegmentDTO[];
  /** Stable source tag surfaced in the response warnings[]. */
  provider: "yttools";
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

/** Per-step fail-fast budget (matches the 8s route checklist). */
export const TRANSCRIPT_STEP_TIMEOUT_MS = 8000;

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

function langMatches(trackLang: string, want: string): boolean {
  const t = trackLang.trim().toLowerCase().replace(/_/g, "-");
  const w = want.trim().toLowerCase().replace(/_/g, "-");
  return t === w || t.startsWith(`${w}-`) || w.startsWith(`${t}-`);
}

/**
 * yttools.co fallback with an 8s fail-fast timeout (backstop for standalone
 * callers; the route additionally bounds fast-path + fallback combined under
 * a single overall 8s budget). When every item reports a language and none
 * matches `lang`, that counts as failure (throws, so the route reports the
 * fast-path error instead of serving the wrong language). Mixed-language
 * payloads are filtered to the requested language before mapping; absent or
 * blank tags are kept (nothing to judge them by), malformed non-string tags
 * are dropped. A bare non-ok status means "no transcript" (never a missing
 * video); only video-scoped wording propagates as video_not_found.
 */
export async function fetchTranscriptFallback(
  id: string,
  lang: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<TranscriptFallbackResult> {
  const url = `https://yttools.co/api/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&lang=${encodeURIComponent(lang)}`;
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(TRANSCRIPT_STEP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A bare 4xx from yttools means "no transcript here", NOT a missing
    // video — keep the error transcript-scoped so it classifies as
    // transcript_unavailable (the shared `\b404\b` rule would otherwise
    // mislabel an existing-but-captionless video as video_not_found). Only
    // video-scoped wording (e.g. "this video is private") propagates as a
    // definitive video_not_found, which the route must NOT serve stale for —
    // bare words like "removed" may describe the transcript, not the video.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
    if (
      /video.{0,40}(private|deleted|removed|unavailable|not found)|(private|deleted|removed|unavailable|not found).{0,40}video/i.test(
        detail,
      )
    ) {
      throw new Error(
        `video_not_found: yttools reports an unavailable video (status ${res.status})`,
      );
    }
    throw new Error(`yttools found no transcript (status ${res.status})`);
  }
  const json: unknown = await res.json();
  if (typeof json !== "object" || json === null) {
    throw new Error("yttools returned an unexpected response shape");
  }
  const raw = (json as { transcript?: unknown }).transcript;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const reported = new Set<string>();
  for (const item of list) {
    if (typeof item === "object" && item !== null) {
      const l = (item as Record<string, unknown>).lang;
      if (typeof l === "string" && l.trim() !== "") {
        reported.add(l);
      }
    }
  }
  // A reported-language mismatch counts as failure only when EVERY item
  // carries a language tag and none matches — an untagged segment alongside
  // foreign-tagged ones may still be the requested language, so it flows
  // into the filter below instead of throwing the whole payload away.
  // Untagged means absent or blank-string; a present non-string tag is
  // malformed — counted as tagged for the guard and dropped by the filter,
  // never served as a guessed language.
  const isUntagged = (item: unknown): boolean => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const l = (item as Record<string, unknown>).lang;
    return l === undefined || (typeof l === "string" && l.trim() === "");
  };
  const tagMatches = (item: unknown): boolean => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const l = (item as Record<string, unknown>).lang;
    return typeof l === "string" && langMatches(l, lang);
  };
  const everyItemTagged =
    list.length > 0 && list.every((item) => !isUntagged(item));
  if (everyItemTagged && ![...reported].some((l) => langMatches(l, lang))) {
    throw new Error(
      `yttools language mismatch: requested ${lang}, got ${[...reported].join(",")}`,
    );
  }
  // Mixed-language payloads serve only the requested language — never leak
  // a wrong-language segment into the response. Untagged items are kept.
  const candidates = list.filter(
    (item) => isUntagged(item) || tagMatches(item),
  );
  const segments: TranscriptSegmentDTO[] = [];
  for (const item of candidates) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const offsetMs = toFiniteNumber(o.offset);
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (offsetMs === undefined || offsetMs < 0 || text === "") {
      continue;
    }
    const dto: TranscriptSegmentDTO = {
      startSeconds: round3(offsetMs / 1000),
      text,
    };
    const durMs = toFiniteNumber(o.duration);
    if (durMs !== undefined && durMs > 0) {
      dto.durationSeconds = round3(durMs / 1000);
    }
    segments.push(dto);
  }
  if (segments.length === 0) {
    throw new Error("yttools returned no transcript segments");
  }
  return { segments, provider: "yttools" };
}
