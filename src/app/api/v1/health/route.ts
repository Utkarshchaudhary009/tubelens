import type { NextRequest } from "next/server";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";

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
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  return handleHealth(requestId, defaultDeps);
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
