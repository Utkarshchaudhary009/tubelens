// Phase 13 (Part B): centralized, versioned weighted-credit operation catalog.
//
// Single source of truth for operation → credit-cost policy (source:
// plans/PLANS_AND_USAGE.md §6 + §8). Every quotable route resolves its
// `{ operation, cost, policyVersion }` record HERE — the pipeline's
// rate-limit stage and usage-accounting stage consume it, and the batch
// fan-out prices children through it. Costs are versioned: durable usage
// rows stamp the resolving policy version, so historical rows are never
// reinterpreted under today's price (§14).
//
// Pure and server-only-safe: this module deliberately avoids
// `import "server-only"` (that package throws unconditionally under bun,
// which would make this module untestable — same rationale as
// `authorize.ts`/`clerk-auth.ts`/`rate-limit.ts`); the no-client guarantee
// comes from the import graph (API-only repo, Route Handlers only).

/** Current quota policy version, stamped on every resolved cost record. */
export const QUOTA_POLICY_VERSION = "2026-09-17.free.v1";

/**
 * Pinned prior policy version (the §14 history anchor). Kept as a tiny
 * snapshot table below so tests and support tooling can resolve what an
 * operation cost under the previous policy without consulting a database.
 */
export const QUOTA_POLICY_PREVIOUS_VERSION = "2026-09-13.free.v1";

/**
 * Hard ceiling on the summed weighted-credit cost of one batch call.
 * A batch whose children total more than this is rejected preflight,
 * before any child work executes. Worst case without a cap would be
 * 10 × combined (40); 20 admits ten cheap reads or a moderate mix while
 * rejecting heavy fan-outs (e.g. 10 × transcript = 30). Well under the
 * burst window (60), so a priced batch always fits the limiter.
 */
export const BATCH_MAX_COST = 20;

/** Max children per batch call (mirrors the batch body schema). */
export const BATCH_MAX_CHILDREN = 10;

export interface QuotaOperation {
  operation: string;
  cost: number;
}

export interface ResolvedOperationCost extends QuotaOperation {
  policyVersion: string;
}

export type QuotaPolicyErrorCode =
  | "unknown_operation"
  | "unknown_policy_version"
  | "batch_cost_exceeded"
  | "invalid_batch";

/** Typed policy failure — never a bare Error, never a silent free pass. */
export class QuotaPolicyError extends Error {
  readonly code: QuotaPolicyErrorCode;

  constructor(code: QuotaPolicyErrorCode, message: string) {
    super(message);
    this.name = "QuotaPolicyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Catalog: pipeline route label → { operation, cost }.
// Classes per PLANS_AND_USAGE.md §6: cheap reads 1, medium reads 2,
// expensive reads 3, composed `combined` 4, batch priced at its ceiling.
// Labels match what routes pass (or will pass) to withRequestContext.
// ---------------------------------------------------------------------------

const CATALOG: Record<string, QuotaOperation> = {
  // Cheap reads (1): metadata, search, profiles, static/policy endpoints.
  health: { operation: "health.check", cost: 1 },
  me: { operation: "me.get", cost: 1 },
  openapi: { operation: "openapi.get", cost: 1 },
  quota: { operation: "quota.get", cost: 1 },
  resolve: { operation: "resolve.get", cost: 1 },
  search: { operation: "search.query", cost: 1 },
  "search.suggestions": { operation: "search.suggest", cost: 1 },
  thumbnails: { operation: "thumbnails.get", cost: 1 },
  instances: { operation: "instances.get", cost: 1 },
  "videos.get": { operation: "videos.get", cost: 1 },
  "videos.captions": { operation: "captions.list", cost: 1 },
  "videos.lyrics": { operation: "lyrics.get", cost: 1 },
  "videos.radio": { operation: "radio.get", cost: 1 },
  "channels.profile": { operation: "channels.get", cost: 1 },
  "channels.rss": { operation: "channels.rss", cost: 1 },
  "playlists.meta": { operation: "playlists.get", cost: 1 },
  "feed.shorts": { operation: "feed.shorts", cost: 1 },
  "feed.live": { operation: "feed.live", cost: 1 },
  "feed.gaming": { operation: "feed.gaming", cost: 1 },
  "music.search": { operation: "music.search", cost: 1 },
  "music.charts": { operation: "music.charts", cost: 1 },
  "hashtags.get": { operation: "hashtags.get", cost: 1 },
  "artists.get": { operation: "artists.get", cost: 1 },
  "mixes.get": { operation: "mixes.get", cost: 1 },
  "tunnel.get": { operation: "tunnel.read", cost: 1 },
  // Admin reads/mutations are local (Clerk) calls, no YouTube upstream.
  "admin.users.role": { operation: "admin.users.role", cost: 1 },
  "admin.users.tier": { operation: "admin.users.tier", cost: 1 },
  "admin.keys.revoke": { operation: "admin.keys.revoke", cost: 1 },
  "admin.keys.create": { operation: "admin.keys.create", cost: 1 },
  "admin.keys.list": { operation: "admin.keys.list", cost: 1 },
  // Medium reads (2): paged listings (channel tabs, playlist items,
  // related/continuation pages) plus single third-party upstream lookups —
  // related walks a continuation page, sponsors/dislikes/dearrow each hit one
  // external source (SponsorBlock/ReturnYouTubeDislike/DeArrow): costlier
  // than local metadata, cheaper than transcript assembly.
  "videos.related": { operation: "videos.related", cost: 2 },
  "videos.comments": { operation: "comments.list", cost: 2 },
  "videos.sponsors": { operation: "sponsors.get", cost: 2 },
  "videos.dislikes": { operation: "dislikes.get", cost: 2 },
  "videos.dearrow": { operation: "dearrow.get", cost: 2 },
  "channels.videos": { operation: "channels.videos", cost: 2 },
  "channels.shorts": { operation: "channels.shorts", cost: 2 },
  "channels.streams": { operation: "channels.streams", cost: 2 },
  "channels.playlists": { operation: "channels.playlists", cost: 2 },
  "playlists.items": { operation: "playlists.items", cost: 2 },
  // Expensive reads (3): transcript assembles timed text across upstream
  // fetches; audio proxies binary stream bytes — both heavy upstream work.
  "videos.transcript": { operation: "transcript.get", cost: 3 },
  "videos.audio": { operation: "audio.get", cost: 3 },
  // Composed read (4): multi-upstream fan-in served as one response, priced
  // inside the PLAN's 4–5 composed range.
  "videos.combined": { operation: "combined.get", cost: 4 },
  // Batch declares its ceiling as its worst-case cost; the actual per-call
  // charge is the summed child cost computed by costForBatch().
  batch: { operation: "batch.execute", cost: BATCH_MAX_COST },
};

/**
 * Prior-version snapshot (§14 history anchor). Only operations whose price
 * moved need entries here for tooling/tests; resolving any other label at
 * this version throws `unknown_operation`, exactly like the live catalog
 * does for labels it never knew. v1 priced the composed read at 5;
 * v-current repriced it to 4.
 */
const PREVIOUS_CATALOG: Record<string, QuotaOperation> = {
  search: { operation: "search.query", cost: 1 },
  "videos.comments": { operation: "comments.list", cost: 2 },
  "videos.transcript": { operation: "transcript.get", cost: 3 },
  "videos.combined": { operation: "combined.get", cost: 5 },
};

/** Every route label the catalog prices (sorted, for tests/docs). */
export function quotaRouteLabels(): string[] {
  return Object.keys(CATALOG).sort();
}

/** True only for labels the catalog prices. Type-narrows on success. */
export function isKnownOperation(route: unknown): route is string {
  return typeof route === "string" && Object.hasOwn(CATALOG, route as string);
}

/**
 * Resolve a pipeline route label to its `{ operation, cost,
 * policyVersion }` record. UNKNOWN labels fail closed with a typed
 * QuotaPolicyError — never a 0/free record.
 */
export function resolveOperationCost(route: string): ResolvedOperationCost {
  const entry = CATALOG[route];
  if (!entry) {
    throw new QuotaPolicyError(
      "unknown_operation",
      `Unknown operation "${route}".`,
    );
  }
  return {
    operation: entry.operation,
    cost: entry.cost,
    policyVersion: QUOTA_POLICY_VERSION,
  };
}

/**
 * Resolve a label against a PINNED policy version (history/support
 * tooling). The current version reads the live catalog; the previous
 * version reads its snapshot. Any other version throws
 * `unknown_policy_version` — history is only explainable for versions we
 * actually pinned.
 */
export function resolveOperationCostAt(
  version: string,
  route: string,
): ResolvedOperationCost {
  if (version === QUOTA_POLICY_VERSION) {
    return resolveOperationCost(route);
  }
  if (version === QUOTA_POLICY_PREVIOUS_VERSION) {
    const entry = PREVIOUS_CATALOG[route];
    if (!entry) {
      throw new QuotaPolicyError(
        "unknown_operation",
        `Unknown operation "${route}" at policy ${version}.`,
      );
    }
    return {
      operation: entry.operation,
      cost: entry.cost,
      policyVersion: version,
    };
  }
  throw new QuotaPolicyError(
    "unknown_policy_version",
    `Unknown policy version "${version}".`,
  );
}

// ---------------------------------------------------------------------------
// Batch economics: child pathname → label → cost, summed with a hard ceiling.
// ---------------------------------------------------------------------------

/**
 * Map a batch child pathname (query string allowed) to its catalog label.
 * Mirrors the batch allowlist's path shapes; anything else — including
 * nested `/api/v1/batch` — throws `unknown_operation` (fail closed).
 */
export function resolveBatchChildRoute(pathname: string): string {
  const path = pathname.split("?")[0] ?? "";
  switch (path) {
    case "/api/v1/health":
      return "health";
    case "/api/v1/openapi.json":
      return "openapi";
    case "/api/v1/resolve":
      return "resolve";
    case "/api/v1/search":
      return "search";
    case "/api/v1/search/suggestions":
      return "search.suggestions";
    case "/api/v1/thumbnails":
      return "thumbnails";
    case "/api/v1/instances":
      return "instances";
    case "/api/v1/quota":
      return "quota";
    default:
      break;
  }
  const video = /^\/api\/v1\/videos\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (video) {
    return batchVideoSubRoute(video[2]);
  }
  const channel = /^\/api\/v1\/channels\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (channel) {
    return batchChannelSubRoute(channel[2]);
  }
  const playlist = /^\/api\/v1\/playlists\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (playlist) {
    return batchPlaylistSubRoute(playlist[2]);
  }
  const feed = /^\/api\/v1\/feed\/(shorts|live|gaming)$/.exec(path);
  if (feed) {
    return `feed.${feed[1]}`;
  }
  const music = /^\/api\/v1\/music\/(search|charts)$/.exec(path);
  if (music) {
    return `music.${music[1]}`;
  }
  if (/^\/api\/v1\/hashtags\/[^/]+$/.test(path)) {
    return "hashtags.get";
  }
  if (/^\/api\/v1\/artists\/[^/]+$/.test(path)) {
    return "artists.get";
  }
  if (/^\/api\/v1\/mixes\/[^/]+$/.test(path)) {
    return "mixes.get";
  }
  throw new QuotaPolicyError(
    "unknown_operation",
    `Unknown batch child path "${path}".`,
  );
}

function batchVideoSubRoute(sub: string | undefined): string {
  switch (sub) {
    case undefined:
      return "videos.get";
    case "related":
      return "videos.related";
    case "comments":
      return "videos.comments";
    case "captions":
      return "videos.captions";
    case "transcript":
      return "videos.transcript";
    case "sponsors":
      return "videos.sponsors";
    case "dislikes":
      return "videos.dislikes";
    case "dearrow":
      return "videos.dearrow";
    case "combined":
      return "videos.combined";
    case "radio":
      return "videos.radio";
    case "lyrics":
      return "videos.lyrics";
    case "audio":
      return "videos.audio";
    default:
      throw new QuotaPolicyError(
        "unknown_operation",
        `Unknown videos sub-route "${sub}".`,
      );
  }
}

function batchChannelSubRoute(sub: string | undefined): string {
  switch (sub) {
    case undefined:
      return "channels.profile";
    case "videos":
      return "channels.videos";
    case "shorts":
      return "channels.shorts";
    case "streams":
      return "channels.streams";
    case "playlists":
      return "channels.playlists";
    case "rss":
      return "channels.rss";
    default:
      throw new QuotaPolicyError(
        "unknown_operation",
        `Unknown channels sub-route "${sub}".`,
      );
  }
}

function batchPlaylistSubRoute(sub: string | undefined): string {
  if (sub === undefined) {
    return "playlists.meta";
  }
  if (sub === "items") {
    return "playlists.items";
  }
  throw new QuotaPolicyError(
    "unknown_operation",
    `Unknown playlists sub-route "${sub}".`,
  );
}

export interface BatchChildCost extends ResolvedOperationCost {
  route: string;
}

export interface ResolvedBatchCost extends ResolvedOperationCost {
  children: BatchChildCost[];
}

/**
 * Price one batch call: sum of resolved child costs. Over the
 * BATCH_MAX_COST ceiling (or a child-count/shape violation) throws a typed
 * QuotaPolicyError — callers must reject BEFORE executing any child, so a
 * rejected batch performs no child work. Phase 13 scope: deterministic
 * costing + ceiling enforcement only; durable credit deduction is Phase 14
 * (full batch economics Phase 16) — see PLANS_AND_USAGE.md §6/§9.
 */
export function costForBatch(childPathnames: string[]): ResolvedBatchCost {
  if (childPathnames.length === 0) {
    throw new QuotaPolicyError(
      "invalid_batch",
      "Batch must contain at least one child.",
    );
  }
  if (childPathnames.length > BATCH_MAX_CHILDREN) {
    throw new QuotaPolicyError(
      "invalid_batch",
      `Batch at most ${BATCH_MAX_CHILDREN} requests per call.`,
    );
  }
  const children: BatchChildCost[] = childPathnames.map((pathname) => {
    const route = resolveBatchChildRoute(pathname);
    const resolved = resolveOperationCost(route);
    return { route, ...resolved };
  });
  const total = children.reduce((sum, child) => sum + child.cost, 0);
  if (total > BATCH_MAX_COST) {
    throw new QuotaPolicyError(
      "batch_cost_exceeded",
      `Batch total cost ${total} exceeds the ceiling of ${BATCH_MAX_COST}.`,
    );
  }
  return {
    operation: "batch.execute",
    cost: total,
    policyVersion: QUOTA_POLICY_VERSION,
    children,
  };
}
