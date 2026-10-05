import type { NextRequest, NextResponse } from "next/server";
import { noteAbuseOutcome } from "@/lib/abuse";
import { getBatchMarkerSecret, mintBatchChildMarker } from "@/lib/batch-marker";
import { clerkAuthProvider } from "@/lib/clerk-auth";
import { type PipelineProviders, withRequestContext } from "@/lib/pipeline";
import { resolveRequestId } from "@/lib/request-context";
import { SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import {
  type BatchChildContext,
  type BatchDeps,
  type BatchOptions,
  executeBatchTasks,
  parseBatchRequest,
  shouldAllowLoopback,
} from "@/lib/utils";

export const runtime = "nodejs";

// Upstream seam: the default implementation re-enters a TRUSTED origin over
// HTTP (pinned via resolveBatchOrigin — explicit TUBELENS_PUBLIC_URL, Vercel
// VERCEL_URL, or loopback local dev; never the raw request Host, so
// Host-header poisoning cannot turn the fan-out into SSRF). Plain fetch, no
// youtubei singleton. Exported for unit tests (forwarding/marker behavior);
// production POST always uses it via createBatchHandler below.
//
// The sub-fetch runs through the SSRF boundary pinned to the first-hop
// origin host (parseBatchRequest built the URL from the trusted origin +
// allowlisted path above): every redirect hop re-validates against THIS
// host, so a cross-origin Location cannot escape the fan-out. Loopback http
// is allowed only when the pinned origin itself is loopback local-dev.
//
// `extraHeaders` (caller credentials + already-billed marker, assembled by
// createBatchHandler from the PARENT request) merge over the x-request-id
// default. Credential forwarding is same-origin back to the app itself, so
// children resolve the caller's principal (a quota child reports the
// caller's balance, never anonymous) instead of 401ing or misattributing.
export const defaultBatchDeps: BatchDeps = {
  async execute(
    url: string,
    requestId: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ) {
    let originHost: string;
    try {
      originHost = new URL(url).hostname.toLowerCase();
    } catch {
      throw new SsrfBlockedError("unparseable URL");
    }
    // Per-call 8s fail-fast AND the batch shared deadline (whichever fires
    // first aborts the sub-fetch).
    const res = await safeFetch(url, {
      allowHosts: [originHost],
      allowLoopback: shouldAllowLoopback(originHost),
      timeoutMs: 8000,
      headers: { "x-request-id": requestId, ...(extraHeaders ?? {}) },
      signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    return { status: res.status, body };
  },
};

/**
 * Caller credential headers forwarded to same-origin child sub-fetches.
 * Authorization + cookie only — enough for the child to resolve the
 * caller's principal; never forwarded anywhere but the pinned origin, and
 * never logged (values pass through untouched).
 */
function callerCredentialHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const authorization = req.headers.get("authorization");
  if (authorization) {
    out.authorization = authorization;
  }
  const cookie = req.headers.get("cookie");
  if (cookie) {
    out.cookie = cookie;
  }
  return out;
}

/** Once-per-process flag for the missing-secret warn below. */
let warnedMissingMarkerSecret = false;

/**
 * Already-billed signer for one admitted batch: HMACs each child URL with
 * the server-only marker secret so the pipeline can verify the child was
 * minted here and skip its re-admission (single summed charge, no
 * double-charge). Undefined when no secret is configured — children then
 * ride unsigned and face normal admission (fail toward charging).
 *
 * REQUIRED in quota-billed deployments: TUBELENS_BATCH_HMAC_KEY (or the
 * CLERK_SECRET_KEY fallback) must be set wherever quota enforcement
 * matters. Without it, every pipeline-wired child is admitted AND charged
 * on top of the parent's summed cost once data routes are pipeline-wired
 * (tracked follow-up #34) — a silent double-charge. The first batch per
 * process logs a warn so the misconfiguration is visible in instance logs.
 */
function batchChildSigner(
  env: Record<string, string | undefined> = process.env,
): ((childUrl: string) => string | null) | undefined {
  // Same environment the pipeline verifies against (providers.env when
  // injected, else process.env) — mint and verify must agree, or every
  // child falls through to normal admission and double-charges.
  const secret = getBatchMarkerSecret(env);
  if (!secret) {
    if (!warnedMissingMarkerSecret) {
      warnedMissingMarkerSecret = true;
      console.warn(
        "[batch] no already-billed marker secret (TUBELENS_BATCH_HMAC_KEY or CLERK_SECRET_KEY); batch children face normal admission and may double-charge in quota-billed deployments.",
      );
    }
    return undefined;
  }
  return (childUrl: string) => {
    try {
      const url = new URL(childUrl);
      return mintBatchChildMarker(secret, "GET", url.pathname + url.search);
    } catch {
      return null;
    }
  };
}

// Phase 16 batch protection and partial-abuse resistance: every POST is
// preflight-priced BEFORE pipeline admission, then admitted exactly once
// with the summed child cost as its single quota/rate-limit charge.
//
//   - Preflight (`parseBatchRequest`, no I/O): zod shape, BATCH_MAX_CHILDREN
//     count gate, GET-only/no-nested/no-binary allowlist, per-item pricing
//     demotion, and the BATCH_MAX_COST ceiling via costForBatch. Rejected
//     preflight returns a whole-batch typed error HERE — the pipeline is
//     never entered, so a rejected batch consumes zero credits AND invokes
//     zero children.
//   - Zero-work batches (every item a static per-item error, nothing to
//     execute) still enter the pipeline: auth, rate-limit (weight 1 —
//     static-error spam is throttled like any other admission), and
//     observability apply, but quota is exempt (nothing executed, nothing
//     consumed) and the single usage row carries cost 0.
//   - Admission (`withRequestContext`, route "batch"): the pipeline peeks
//     the monthly allowance for the summed cost (short of credits → 429
//     `quota_exceeded`, handler never runs, nothing consumed) and records
//     consumption once post-response — even when individual children fail,
//     because per-child failures stay per-child {status, body} entries in
//     an admitted 200 (never a whole-batch 502).
//   - Children NEVER double-charge: they run as sub-fetches carrying the
//     caller's credentials plus a server-minted already-billed marker; the
//     pipeline verifies the marker and skips the child's rate-limit/quota/
//     usage stages, so the single summed charge above is the batch's only
//     charge. Forged markers (or no configured secret) fall through to
//     normal admission — fail toward charging, never toward free serving.
//   - Retry is a NEW full-cost attempt, not deduped execution: the pipeline
//     mints a fresh server-side billingKey per admitted attempt (never
//     derived from the client-echoable X-Request-Id), so replaying the same
//     body re-charges the full summed cost and yields a deterministic
//     verdict (same allowlist/pricing decisions, modulo upstream results).
//   - Accounting is one usage row per batch (summed cost + priced-child
//     summary + policy version), never one row per child; the response stays
//     private, no-store with no L0 write.
export function createBatchHandler(
  deps: BatchDeps = defaultBatchDeps,
  providers: PipelineProviders = { auth: clerkAuthProvider },
  batchOpts?: BatchOptions,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const preflight = await parseBatchRequest(req);
    if (!preflight.ok) {
      // Phase 17: preflight rejects never enter the pipeline (zero charge,
      // zero children), so the pipeline cannot count them — count the
      // batch_rejected signal here instead. AWAITED in-request, never
      // detached: Vercel freezes detached work after the response, so auth
      // resolves BEFORE the rejection returns; the counting itself is
      // synchronous (batch rejects are warn-only, never enforced). The extra
      // resolve costs no more than any admitted request's auth, and the
      // whole path is best-effort (never throws, never delays past auth).
      await noteBatchPreflightReject(providers, req);
      return preflight.response;
    }
    const admitted = preflight.value;
    const childCtx: BatchChildContext = {
      forwardedHeaders: callerCredentialHeaders(req),
      signChild: batchChildSigner(providers.env ?? process.env),
    };
    // Zero-work batches admit at the limiter floor (weight 1) with quota
    // exemption: throttled and observed like any admission, but consuming
    // zero credits for executing nothing.
    const zeroWork = admitted.totalCost === 0;
    return withRequestContext(
      async (_r, ctx) =>
        executeBatchTasks(
          admitted.tasks,
          deps,
          ctx.requestId,
          batchOpts,
          childCtx,
        ),
      providers,
      "batch",
      {
        costOverride: zeroWork ? 1 : admitted.totalCost,
        quotaExempt: zeroWork,
        usageChildren: admitted.children,
      },
    )(req);
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return createBatchHandler()(req);
}

/**
 * Phase 17 abuse signal for batch preflight rejects (oversize bodies,
 * over-count/cost fan-outs, malformed shapes). Awaited in-request by the
 * caller (never detached past the response — Vercel freezes that work), and
 * fully synchronous once auth resolves: `batch_rejected` is warn-only, so no
 * enforcement await exists on this path. Keying matches the pipeline abuse
 * principal (key-first, never owner-first — one key's rejects must not pool
 * under the owner's user identity), and `targetUserId` rides along ONLY for
 * `user:` principals (a key's row names the key, never the owner's subject
 * — the pipeline convention). Never throws.
 */
async function noteBatchPreflightReject(
  providers: PipelineProviders,
  req: NextRequest,
): Promise<void> {
  try {
    const auth = await (providers.auth ?? clerkAuthProvider).resolve(req);
    const principal =
      auth.keyId !== undefined && auth.keyId !== ""
        ? `key:${auth.keyId}`
        : auth.userId !== undefined && auth.userId !== ""
          ? `user:${auth.userId}`
          : "anonymous";
    noteAbuseOutcome({
      principal,
      route: "batch",
      outcome: "batch_rejected",
      requestId: resolveRequestId(req),
      ...(principal.startsWith("user:") &&
      auth.userId !== undefined &&
      auth.userId !== ""
        ? { targetUserId: auth.userId }
        : {}),
    });
  } catch {
    // Intentionally ignored — abuse counting must never break a response.
  }
}
