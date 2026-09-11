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
 * payloads are filtered to the requested language before mapping; items with
 * no language tag are kept (nothing to judge them by).
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
    throw new Error(`yttools request failed with status ${res.status}`);
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
  if (reported.size > 0 && ![...reported].some((l) => langMatches(l, lang))) {
    throw new Error(
      `yttools language mismatch: requested ${lang}, got ${[...reported].join(",")}`,
    );
  }
  // Mixed-language payloads serve only the requested language — never leak
  // a wrong-language segment into the response. Untagged items are kept.
  const candidates = list.filter((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const l = (item as Record<string, unknown>).lang;
    return typeof l !== "string" || l.trim() === "" || langMatches(l, lang);
  });
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
