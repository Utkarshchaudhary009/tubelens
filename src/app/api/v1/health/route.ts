import type { NextRequest } from "next/server";
import { CACHE_CONTROL, successResponse } from "@/lib/envelope";
import { withRequestContext } from "@/lib/pipeline";

export const runtime = "nodejs";

// Upstream seam: the default implementation checks the youtubei.js session
// (imported lazily so this module stays importable without the server-only
// singleton). Tests inject mocks here and never touch src/lib/youtube.
export interface HealthDeps {
  checkSession: () => Promise<void>;
}

const defaultDeps: HealthDeps = {
  async checkSession() {
    const { getInnertube, withTimeout } = await import("@/lib/youtube");
    await withTimeout(() => getInnertube(), 8000);
  },
};

// Liveness + youtubei.ts session status. Liveness must stay green, so an
// upstream session failure returns 200 with session "degraded" plus a
// warnings entry — never a 500.
//
// Phase 01 (Part B): GET runs through the shared request pipeline
// (withRequestContext) so every call gets a typed RequestContext; the
// envelope output is unchanged (Part A wire contract preserved).
// Liveness must never be rejected by request providers: bypassRateLimit
// skips only the limiter check (context creation, request ids, and headers
// still apply). This option exists ONLY for liveness — never for data
// routes, which must always face rate-limit/quota enforcement; the pipeline
// enforces that invariant by path. Accepted risk is bounded at the origin
// by CDN caching: ready probes carry CACHE_CONTROL.health
// (`public, s-maxage=60`, roughly one origin hit per minute), while the
// degraded path carries CACHE_CONTROL.healthDegraded (`s-maxage=10`,
// roughly six origin hits per minute during a sustained outage, each
// possibly hitting the 8s upstream timeout).
export async function GET(req: NextRequest) {
  return withRequestContext(
    async (_r, ctx) => handleHealth(ctx.requestId, defaultDeps),
    {},
    "health",
    { bypassRateLimit: true },
  )(req);
}

export async function handleHealth(
  requestId: string,
  deps: HealthDeps = defaultDeps,
) {
  try {
    await deps.checkSession();
    // Version mirrors package.json; keep in sync with openapi info.version.
    return successResponse(
      { ok: true, session: "ready", version: "0.1.0" },
      { requestId, cacheControl: CACHE_CONTROL.health },
    );
  } catch {
    return successResponse(
      { ok: true, session: "degraded", version: "0.1.0" },
      {
        requestId,
        cacheControl: CACHE_CONTROL.healthDegraded,
        warnings: [
          {
            code: "session_degraded",
            message:
              "YouTube session could not be established; liveness unaffected.",
          },
        ],
      },
    );
  }
}
