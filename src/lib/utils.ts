// Phase 10 (Utils and polish) shared handlers.
// Interop, performance, and self-description helpers: channel RSS feeds,
// seed -> mix id lookup, a pure thumbnail URL resolver, peer instance status,
// single-round-trip batch reads, and stub quota counters. JSON routes ride
// the shared envelope (X-Request-Id + X-RateLimit-* + typed error hints);
// the RSS feed is served RAW as application/rss+xml (like the audio-bytes
// and openapi precedents — feed readers cannot parse the JSON envelope).
// $0: CDN + in-memory only, no durable store, no new dependencies.

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cached } from "@/lib/cache";
import {
  classifyChannelError,
  mapChannelVideo,
  normalizeChannelKey,
  parseChannelId,
} from "@/lib/channels";
import type { ContinuationSearch } from "@/lib/continuations";
import {
  baseHeaders,
  CACHE_CONTROL,
  getRequestId,
  successResponse,
} from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { isUpstreamTimeout, textOf } from "@/lib/mappers";
import { isPlausibleVideoId } from "@/lib/validate";

// ---------------------------------------------------------------------------
// RSS: GET /api/v1/channels/:id/rss
// ---------------------------------------------------------------------------

export interface ChannelRssDeps {
  /** UC id or @handle -> canonical UC channel id (handles via resolveURL). */
  resolveChannelId: (input: string) => Promise<string>;
  /**
   * Canonical UC id -> one getChannel payload plus its adapted uploads
   * first page. A SINGLE upstream fetch serves both (title + tab) — never
   * one getChannel per half.
   */
  fetchChannel: (channelId: string) => Promise<{
    profile: unknown;
    firstPage: ContinuationSearch;
  }>;
}

interface RssItem {
  id: string;
  title: string;
}

/** RSS items served per feed (latest uploads only — no cursor paging). */
export const RSS_MAX_ITEMS = 20;

/** L0 fresh window for the composed feed; L1 CDN carries the 600s TTL. */
const RSS_FRESH_MS = 10 * 60 * 1000;
/** Stale window backs serve-stale-on-error (mirrors the 3600s SWR). */
const RSS_STALE_MS = 60 * 60 * 1000;

/**
 * Minimal XML escaping for text interpolated into the feed (titles and
 * URLs). Covers &, <, >, ", and ' — enough for well-formed RSS 2.0.
 */
export function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Tolerant channel-title reader for getChannel payloads (any header). */
export function rssChannelTitle(raw: unknown): string | undefined {
  const root = asRecord(raw);
  if (!root) {
    return undefined;
  }
  const header = asRecord(root.header);
  const metadata = asRecord(root.metadata);
  const author = asRecord(header?.author);
  // Mirrors mapChannelProfile: youtubei names are often Text objects/runs,
  // not plain strings — textOf covers both shapes.
  const title =
    (typeof author?.name === "string" && author.name) ||
    textOf(author?.name) ||
    textOf(header?.title) ||
    textOf(metadata?.title);
  if (typeof title !== "string" || title.trim() === "") {
    return undefined;
  }
  return title;
}

/** Builds a well-formed RSS 2.0 document from uploads (already escaped). */
export function buildChannelRss(
  channelId: string,
  channelTitle: string,
  items: RssItem[],
): string {
  const channelLink = `https://www.youtube.com/channel/${channelId}`;
  const capped = items.slice(0, RSS_MAX_ITEMS);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "<channel>",
    `<title>${escapeXml(channelTitle)}</title>`,
    `<link>${escapeXml(channelLink)}</link>`,
    `<description>${escapeXml(`Latest uploads from ${channelTitle}`)}</description>`,
  ];
  for (const item of capped) {
    const watchUrl = `https://www.youtube.com/watch?v=${item.id}`;
    lines.push(
      "<item>",
      `<title>${escapeXml(item.title)}</title>`,
      `<link>${escapeXml(watchUrl)}</link>`,
      `<guid>${escapeXml(watchUrl)}</guid>`,
      "</item>",
    );
  }
  lines.push("</channel>", "</rss>");
  return lines.join("\n");
}

export async function handleChannelRss(
  req: NextRequest,
  rawId: string,
  deps: ChannelRssDeps,
): Promise<NextResponse> {
  const requestId = getRequestId(req);

  const parsed = parseChannelId(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }

  try {
    // Handles resolve to the canonical UC id first so @handle and UC form
    // share one L0 entry and one CDN object.
    const channelId = await deps.resolveChannelId(parsed.value.value);
    const cacheKey = `utils:rss:v1:${normalizeChannelKey({ kind: "id", value: channelId })}`;
    const result = await cached<{ title: string; items: RssItem[] }>(
      cacheKey,
      RSS_FRESH_MS,
      async () => {
        const { profile, firstPage } = await deps.fetchChannel(channelId);
        const title = rssChannelTitle(profile) ?? "Untitled channel";
        const items = firstPage.results
          .slice(0, RSS_MAX_ITEMS)
          .map(mapChannelVideo)
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .map((d) => ({ id: d.id, title: d.title }));
        return { title, items };
      },
      RSS_STALE_MS,
      // Definitive not-found errors must NOT serve stale — only transient
      // failures (timeout/429/5xx) may. Not-found propagates below.
      (err) => classifyChannelError(err).code !== "channel_not_found",
    );
    // RAW feed (no JSON envelope): feed readers consume the URL directly.
    // Tracing/rate-limit/cache headers still apply. No meta block exists, so
    // staleness is not signaled in-body — the CDN TTL absorbs repeat reads.
    const headers = baseHeaders(requestId);
    headers.set("Content-Type", "application/rss+xml; charset=utf-8");
    headers.set("Cache-Control", CACHE_CONTROL.channelFeed);
    return new NextResponse(
      buildChannelRss(channelId, result.value.title, result.value.items),
      { status: 200, headers },
    );
  } catch (err) {
    return errorResponse(requestId, classifyChannelError(err));
  }
}

// ---------------------------------------------------------------------------
// Mixes: GET /api/v1/mixes/:id (seed -> mix id lookup, pure resolver)
// ---------------------------------------------------------------------------

const MIX_ID = /^[A-Za-z0-9_-]{2,64}$/;
const RD_MIX = /^RD[A-Za-z0-9_-]{1,62}$/;

export interface ParsedMixSeed {
  /** The RD mix playlist id to read. */
  mixId: string;
  /** The seed the mix was derived from (video id, RD remainder, or id). */
  seedId: string;
}

export interface MixSeedError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export type MixSeedResult =
  | { ok: true; value: ParsedMixSeed }
  | { ok: false; error: MixSeedError };

/**
 * Pure seed -> mix id lookup. RD mix ids pass through (seed = remainder);
 * any other mix/playlist-ish id is treated as a seed and maps to RD+seed —
 * the YouTube automix id convention. Existence is NOT checked upstream;
 * callers read items via GET /api/v1/playlists/{mixId} (404 there when the
 * mix does not exist).
 */
export function parseMixSeed(raw: string): MixSeedResult {
  const value = (raw ?? "").trim();
  if (RD_MIX.test(value)) {
    return { ok: true, value: { mixId: value, seedId: value.slice(2) } };
  }
  if (MIX_ID.test(value) && value !== "RD" && isPlausibleVideoId(value)) {
    return { ok: true, value: { mixId: `RD${value}`, seedId: value } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_mix_id",
      message: "Invalid mix id.",
      hint: "Use a video id seed (e.g. /api/v1/mixes/dQw4w9WgXcQ) or an RD mix id, then read items via /api/v1/playlists/{mixId}.",
      status: 400,
    },
  };
}

export async function handleMix(
  req: NextRequest,
  rawId: string,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const parsed = parseMixSeed(rawId);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  return successResponse(parsed.value, {
    requestId,
    cacheControl: CACHE_CONTROL.playlist,
    warnings: [
      {
        code: "mix_items_via_playlist",
        message: "Read mix items via /api/v1/playlists/{mixId}.",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Thumbnails: GET /api/v1/thumbnails (pure i.ytimg.com resolver)
// ---------------------------------------------------------------------------

export const THUMB_QUALITIES = ["default", "medium", "high"] as const;
export type ThumbQuality = (typeof THUMB_QUALITIES)[number];

export interface ParsedThumbnailParams {
  videoId: string;
  quality: ThumbQuality;
}

export interface ThumbnailParamsError {
  code: string;
  message: string;
  hint: string;
  status: number;
}

export type ThumbnailParamsResult =
  | { ok: true; value: ParsedThumbnailParams }
  | { ok: false; error: ThumbnailParamsError };

/** Pure validation for ?videoId=&quality= (quality defaults to medium). */
export function parseThumbnailParams(
  params: URLSearchParams,
): ThumbnailParamsResult {
  const videoId = (params.get("videoId") ?? "").trim();
  if (!isPlausibleVideoId(videoId)) {
    return {
      ok: false,
      error: {
        code: "invalid_video_id",
        message: "Invalid video id.",
        hint: "Use a YouTube video id, e.g. /api/v1/thumbnails?videoId=dQw4w9WgXcQ.",
        status: 400,
      },
    };
  }
  const qualityRaw = (params.get("quality") ?? "medium").trim().toLowerCase();
  const quality = (THUMB_QUALITIES as readonly string[]).includes(qualityRaw)
    ? (qualityRaw as ThumbQuality)
    : null;
  if (!quality) {
    return {
      ok: false,
      error: {
        code: "invalid_quality",
        message: `Invalid quality "${params.get("quality")}".`,
        hint: "Use one of: default, medium, high.",
        status: 400,
      },
    };
  }
  return { ok: true, value: { videoId, quality } };
}

export interface ThumbnailUrls {
  default: string;
  medium: string;
  high: string;
  standard: string;
  maxres: string;
}

/**
 * Builds public i.ytimg.com thumbnail URLs for a video id. Pure pattern
 * resolver — no upstream call, and signed/proxied URLs are never involved.
 * Note: standard/maxres renditions do not exist for every video (YouTube
 * answers 404 for those files); default/medium/high always resolve.
 */
export function thumbnailUrls(videoId: string): ThumbnailUrls {
  const base = `https://i.ytimg.com/vi/${videoId}`;
  return {
    default: `${base}/default.jpg`,
    medium: `${base}/mqdefault.jpg`,
    high: `${base}/hqdefault.jpg`,
    standard: `${base}/sddefault.jpg`,
    maxres: `${base}/maxresdefault.jpg`,
  };
}

export async function handleThumbnails(
  req: NextRequest,
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const parsed = parseThumbnailParams(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return errorResponse(requestId, { ...parsed.error });
  }
  const urls = thumbnailUrls(parsed.value.videoId);
  return successResponse(
    {
      videoId: parsed.value.videoId,
      quality: parsed.value.quality,
      urls,
      best: urls[parsed.value.quality],
    },
    { requestId, cacheControl: CACHE_CONTROL.staticish },
  );
}

// ---------------------------------------------------------------------------
// Instances: GET /api/v1/instances (static peer list)
// ---------------------------------------------------------------------------

export interface InstanceEntry {
  url: string;
  /** True for the instance serving this response. */
  self: boolean;
  status: string;
}

/** Max peers honored from the env list (static in-code cap, $0). */
export const MAX_PEERS = 20;

/**
 * Parses TUBELENS_PEER_INSTANCES (comma-separated https URLs) into clean
 * peer URLs: trims, drops empties/duplicates/non-http(s) values, caps at 20.
 */
export function parsePeerInstances(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim().replace(/\/+$/, "");
    if (url === "" || seen.has(url)) {
      continue;
    }
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_PEERS) {
      break;
    }
  }
  return out;
}

/** Self entry first, then configured peers (failover-aware clients). */
export function getInstances(
  selfUrl: string,
  peers: string[],
): InstanceEntry[] {
  const entries: InstanceEntry[] = [
    { url: selfUrl, self: true, status: "ready" },
  ];
  for (const url of peers) {
    if (url !== selfUrl) {
      entries.push({ url, self: false, status: "unknown" });
    }
  }
  return entries;
}

export async function handleInstances(req: NextRequest): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const selfUrl = req.nextUrl.origin;
  const peers = parsePeerInstances(process.env.TUBELENS_PEER_INSTANCES);
  // Short-lived: peer status is point-in-time, not cacheable metadata.
  return successResponse(
    { instances: getInstances(selfUrl, peers) },
    { requestId, cacheControl: CACHE_CONTROL.health },
  );
}

// ---------------------------------------------------------------------------
// Batch: POST /api/v1/batch (one round-trip, per-item error isolation)
// ---------------------------------------------------------------------------

const batchItemSchema = z.object({
  method: z.string(),
  path: z.string(),
});
const batchBodySchema = z.object({
  requests: z.array(batchItemSchema).min(1).max(10),
});

export interface BatchSubResult {
  status: number;
  body: unknown;
}

export interface BatchDeps {
  /**
   * Executes one allowlisted same-origin GET path -> {status, body}.
   * Receives the batch abort signal: abort promptly when the shared fan-out
   * deadline fires so losing sub-fetches stop instead of dangling.
   * Executors that ignore it are still bounded by the race (their late
   * rejections are caught per-item, never unhandled).
   */
  execute: (
    url: string,
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<BatchSubResult>;
}

/**
 * GET-only allowlist of existing v1 GET paths (query strings allowed).
 * POST /api/v1/batch itself is never allowlisted — nesting is rejected.
 * Binary routes are excluded: batch composes JSON bodies, so audio bytes
 * (/videos/{id}/audio) and the XML feed (/channels/{id}/rss) answer per-item
 * 400 batch_path_not_allowed — call them directly instead.
 */
const BATCH_ALLOWLIST: RegExp[] = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/openapi\.json$/,
  /^\/api\/v1\/resolve$/,
  /^\/api\/v1\/search$/,
  /^\/api\/v1\/search\/suggestions$/,
  /^\/api\/v1\/thumbnails$/,
  /^\/api\/v1\/instances$/,
  /^\/api\/v1\/quota$/,
  /^\/api\/v1\/videos\/[^/]+$/,
  /^\/api\/v1\/videos\/[^/]+\/(related|comments|captions|transcript|sponsors|dislikes|dearrow|combined|radio|lyrics)$/,
  /^\/api\/v1\/channels\/[^/]+$/,
  /^\/api\/v1\/channels\/[^/]+\/(videos|shorts|streams|playlists)$/,
  /^\/api\/v1\/playlists\/[^/]+$/,
  /^\/api\/v1\/playlists\/[^/]+\/items$/,
  /^\/api\/v1\/feed\/(shorts|live|gaming)$/,
  /^\/api\/v1\/music\/(search|charts)$/,
  /^\/api\/v1\/hashtags\/[^/]+$/,
  /^\/api\/v1\/artists\/[^/]+$/,
  /^\/api\/v1\/mixes\/[^/]+$/,
];

function batchItemError(
  status: number,
  code: string,
  message: string,
  hint: string,
): BatchSubResult {
  return { status, body: { error: { code, message, hint, status } } };
}

/** Fresh per-item timeout body (never shared across items). */
function batchTimeoutError(pathname: string): BatchSubResult {
  return batchItemError(
    504,
    "batch_timeout",
    `Sub-request "${pathname}" timed out.`,
    "Retry the timed-out item individually; include X-Request-Id in bug reports.",
  );
}

/**
 * Shared ceiling for the whole fan-out (same 8s fail-fast budget as every
 * other upstream call). Sub-requests run CONCURRENTLY via Promise.all
 * (order-preserving); each item additionally races this shared deadline so
 * one hung sub-request cannot wedge the batch past function timeout.
 * Per-item isolation holds throughout: a timeout/failure degrades that item
 * to a typed error, never the whole batch.
 */
export const BATCH_OVERALL_MS = 8000;

export interface BatchOptions {
  /** Override for the shared fan-out ceiling (tests only; default 8000). */
  overallMs?: number;
}

/** Validated item: either a static error or a same-origin URL to execute. */
type BatchTask =
  | { kind: "static"; result: BatchSubResult }
  | { kind: "run"; url: string; pathname: string };

function validateBatchItem(
  item: { method: string; path: string },
  origin: string,
): BatchTask {
  const method = item.method.trim().toUpperCase();
  const path = item.path.trim();
  if (method !== "GET") {
    return {
      kind: "static",
      result: batchItemError(
        400,
        "batch_method_not_allowed",
        `Invalid method "${item.method}".`,
        "Batch items must use method GET; POST /api/v1/batch is the only write-shaped endpoint.",
      ),
    };
  }
  if (!path.startsWith("/api/v1/") || path.length > 2000) {
    return {
      kind: "static",
      result: batchItemError(
        400,
        "batch_invalid_path",
        "Invalid batch path.",
        "Use a same-origin v1 path, e.g. /api/v1/health or /api/v1/search?q=lofi.",
      ),
    };
  }
  const pathname = path.split("?")[0] as string;
  if (pathname === "/api/v1/batch" || pathname.startsWith("/api/v1/batch/")) {
    return {
      kind: "static",
      result: batchItemError(
        400,
        "batch_nested",
        "Nested batch requests are not allowed.",
        "Inline the inner requests in the outer requests array instead.",
      ),
    };
  }
  if (!BATCH_ALLOWLIST.some((re) => re.test(pathname))) {
    return {
      kind: "static",
      result: batchItemError(
        400,
        "batch_path_not_allowed",
        `Path "${pathname}" is not batchable.`,
        "Batch composes JSON-only v1 reads; binary routes (audio bytes, RSS feed) are excluded — call them directly. See /api/v1/openapi.json for the path list.",
      ),
    };
  }
  return { kind: "run", url: `${origin}${path}`, pathname };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const VERCEL_HOST = /^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$/i;

/**
 * Trusted sub-request origin for the batch fan-out. NEVER the raw request
 * Host: Host-header poisoning would turn the server-side fan-out into an
 * SSRF primitive. Precedence: explicit TUBELENS_PUBLIC_URL, the Vercel
 * system VERCEL_URL, else loopback-only local dev (non-production only) —
 * anything else fails closed (null -> 503 batch_not_configured).
 */
export function resolveBatchOrigin(req: NextRequest): string | null {
  const explicit = (process.env.TUBELENS_PUBLIC_URL ?? "").trim();
  if (explicit !== "") {
    try {
      const url = new URL(explicit);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.origin;
      }
    } catch {
      // Invalid explicit URL: fall through to the next source.
    }
  }
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel !== "" && VERCEL_HOST.test(vercel) && !vercel.includes("..")) {
    return `https://${vercel.toLowerCase()}`;
  }
  // Local dev only and NEVER in production: a loopback Host proves nothing
  // about trust — the port is attacker-chosen via Host (e.g. an internal
  // service on 127.0.0.1:<port>), so production without a configured origin
  // fails closed instead. Vercel prod always sets VERCEL_URL, so behavior
  // there is unchanged.
  if (process.env.NODE_ENV !== "production") {
    try {
      const url = new URL(req.url);
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (LOOPBACK_HOSTS.has(host)) {
        return url.origin;
      }
    } catch {
      // Malformed request URL -> fail closed.
    }
  }
  return null;
}

export async function handleBatch(
  req: NextRequest,
  deps: BatchDeps,
  opts?: BatchOptions,
): Promise<NextResponse> {
  const requestId = getRequestId(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(requestId, {
      code: "invalid_batch",
      message: "Invalid batch body.",
      hint: 'Send JSON {requests:[{method,path}]}, e.g. {"requests":[{"method":"GET","path":"/api/v1/health"}]}.',
      status: 400,
    });
  }
  const parsed = batchBodySchema.safeParse(raw);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some(
      (i) => i.code === "too_big" && String(i.path).includes("requests"),
    );
    return errorResponse(requestId, {
      code: "invalid_batch",
      message: "Invalid batch body.",
      hint: tooMany
        ? "Batch at most 10 requests per call; split larger fan-outs across calls."
        : 'Send {requests:[{method,path}]} with 1-10 GET-only v1 paths, e.g. {"requests":[{"method":"GET","path":"/api/v1/health"}]}.',
      status: 400,
    });
  }

  const origin = resolveBatchOrigin(req);
  if (!origin) {
    return errorResponse(requestId, {
      code: "batch_not_configured",
      message: "Batch fan-out origin is not configured.",
      hint: "Set TUBELENS_PUBLIC_URL to the public base URL so sub-requests dispatch to a trusted origin.",
      status: 503,
    });
  }
  const tasks = parsed.data.requests.map((item) =>
    validateBatchItem(item, origin),
  );

  // Shared deadline: every runnable item races the same gate, so the whole
  // fan-out settles within overallMs no matter how many items hang. Each
  // timed-out item builds a FRESH error body (never a shared alias), and the
  // gate aborts losing sub-fetches via the batch AbortController.
  const overallMs = opts?.overallMs ?? BATCH_OVERALL_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, overallMs);
  });
  let results: BatchSubResult[];
  try {
    results = await Promise.all(
      tasks.map((task) => {
        if (task.kind === "static") {
          return Promise.resolve(task.result);
        }
        const run = (async (): Promise<BatchSubResult> => {
          try {
            return await deps.execute(task.url, requestId, controller.signal);
          } catch (err) {
            // Timeouts are timeouts wherever they fire: the shared-deadline
            // abort AND the per-item fail-fast (AbortSignal.timeout) both
            // surface here, so classify TimeoutError/AbortError as 504 too —
            // otherwise the two equal 8s budgets race nondeterministically
            // between 502 and 504. Anything else stays 502.
            if (controller.signal.aborted || isUpstreamTimeout(err)) {
              return batchTimeoutError(task.pathname);
            }
            // Per-item isolation: one failing item never fails the whole batch.
            return batchItemError(
              502,
              "batch_upstream_failed",
              `Sub-request "${task.pathname}" failed upstream.`,
              "Retry the failed item individually; include X-Request-Id in bug reports.",
            );
          }
        })();
        const timeout = deadline.then(
          (): BatchSubResult => batchTimeoutError(task.pathname),
        );
        return Promise.race([run, timeout]);
      }),
    );
  } finally {
    clearTimeout(timer);
  }

  // Private: the composed page is caller-specific, never CDN-shared.
  return successResponse(
    { results },
    {
      requestId,
      cacheControl: CACHE_CONTROL.noStore,
    },
  );
}

// ---------------------------------------------------------------------------
// Quota: GET /api/v1/quota (in-memory stub counters, no durable store)
// ---------------------------------------------------------------------------

/** Stub window: 100 requests per 60s per instance (mirrors baseHeaders). */
export const QUOTA_LIMIT = 100;
export const QUOTA_WINDOW_MS = 60 * 1000;

let quotaWindowStart = 0;
let quotaUsed = 0;

/** Test helper — resets the in-memory stub counters. */
export function resetQuotaForTests(): void {
  quotaWindowStart = 0;
  quotaUsed = 0;
}

export interface QuotaSnapshot {
  limit: number;
  remaining: number;
  /** Unix-seconds reset of the current window (mirrors X-RateLimit-Reset). */
  reset: number;
  used: number;
}

/** Rolling 60s stub window; rolls over automatically, never persists. */
export function getQuotaSnapshot(now: number = Date.now()): QuotaSnapshot {
  if (quotaWindowStart === 0 || now - quotaWindowStart >= QUOTA_WINDOW_MS) {
    quotaWindowStart = now;
    quotaUsed = 0;
  }
  quotaUsed += 1;
  return {
    limit: QUOTA_LIMIT,
    remaining: Math.max(0, QUOTA_LIMIT - quotaUsed),
    reset: Math.floor(quotaWindowStart / 1000) + 60,
    used: quotaUsed,
  };
}

export async function handleQuota(req: NextRequest): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const snap = getQuotaSnapshot();
  // Private: counters are per-instance and caller-visible only.
  const res = successResponse(
    {
      limit: snap.limit,
      remaining: snap.remaining,
      reset: snap.reset,
      windows: [
        {
          window: "60s",
          limit: snap.limit,
          used: snap.used,
          remaining: snap.remaining,
          reset: snap.reset,
          note: "Stub: in-memory per-instance counters with no durable store; values reset on deploy and differ across instances.",
        },
      ],
    },
    { requestId, cacheControl: CACHE_CONTROL.noStore },
  );
  // Body/header parity: baseHeaders() stamps static stub values, so override
  // with this window's snapshot — the /quota body and X-RateLimit-* agree.
  res.headers.set("X-RateLimit-Limit", String(snap.limit));
  res.headers.set("X-RateLimit-Remaining", String(snap.remaining));
  res.headers.set("X-RateLimit-Reset", String(snap.reset));
  return res;
}
