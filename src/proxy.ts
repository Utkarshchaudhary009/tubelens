import { clerkMiddleware } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { hasClerkSecret } from "./lib/clerk-auth";
import { getRequestId } from "./lib/envelope";
import {
  applyCorsHeaders,
  applySecurityHeaders,
  handlePreflight,
  isApiPath,
  shouldPreflightRequest,
} from "./lib/http-headers";

// Phase 02 session attachment (Next 16: `proxy.ts`, not `middleware.ts` —
// shipping both files is a build error; with `src/` layout this file lives
// at `src/proxy.ts`).
//
// The proxy NEVER authorizes: it only attaches the Clerk session so the
// route-level `clerkAuthProvider` can resolve identity. All 37 public Part A
// routes pass through untouched (byte-identical); protected routes enforce
// in the handler via `requireAuth()`, so denials stay machine-readable
// typed-401 JSON (never browser redirects or 404s).
const runClerk = clerkMiddleware();

// Session-attach gate keys on CLERK_SECRET_KEY alone — the same predicate
// the route-level provider uses (see `hasClerkSecret`). Requiring the
// publishable key here too would split the two layers: secret-without-
// publishable would skip attach in the proxy while the provider still tried
// to resolve, silently 401ing every signed-in /api/v1/me call. The
// publishable key stays out of the server-side required config on purpose
// (public client config, not a secret; `getConfig` treats required +
// secret-only as valid and Phase 01 tests pin that).
//
// Degrade closed: the Clerk SDK throws its missing-key error at request time
// (sync or async — the v7 handler is async) when half-configured, so any
// failure falls through to `NextResponse.next()`. The request then resolves
// anonymous: protected routes deny via `requireAuth()` (typed 401) while
// public routes keep serving — never a framework 500, never a bypass.
// Phase 09: the proxy is the single choke point that sees every request,
// so it owns two HTTP-hardening jobs for /api/v1 (real routes and unknown
// paths alike, bare /api/v1/ included):
//   1. Preflight short-circuit — browser OPTIONS never reaches a route (real
//      GET-only/POST-only routes would 405 or render HTML); it is answered
//      centrally with a 204 + CORS grant, no auth required.
//   2. Pass-through stamping — every real GET/POST/PATCH response gets the
//      security baseline (idempotent with the envelope) plus the CORS grant
//      for allowlisted origins (never `*`, no credentials), so the ~40
//      handlers need no per-route CORS code and future routes inherit it.
// Non-API paths pass through untouched.
function stampApiResponse(res: Response, req: NextRequest): Response {
  applySecurityHeaders(res.headers);
  applyCorsHeaders(res.headers, req.headers.get("origin"));
  return res;
}

export default function proxy(...args: Parameters<typeof runClerk>) {
  const req = args[0] as NextRequest;
  if (shouldPreflightRequest(req)) {
    return handlePreflight(req, getRequestId(req));
  }
  const pathname = req.nextUrl.pathname;
  // Clerk may resolve to undefined (continue) or a plain Response — only
  // stamp real Response objects on API paths. A falsy result materializes a
  // pass-through first: raw paths (openapi.json, RSS, audio bytes, the
  // catch-all) bypass the pipeline backfill, so without this they would
  // leave the proxy with no security/CORS stamp when Clerk continues.
  type MiddlewareOut = Awaited<ReturnType<typeof runClerk>>;
  const stamp = (res: MiddlewareOut): MiddlewareOut => {
    const pass: Response = res instanceof Response ? res : NextResponse.next();
    return (
      isApiPath(pathname) ? stampApiResponse(pass, req) : pass
    ) as MiddlewareOut;
  };
  if (!hasClerkSecret()) {
    return stamp(NextResponse.next());
  }
  try {
    const out = runClerk(...args);
    if (out instanceof Promise) {
      return out.then(stamp, () => stamp(NextResponse.next()));
    }
    return stamp(out);
  } catch {
    return stamp(NextResponse.next());
  }
}

// Covers /api/v1/me (and future protected routes) while leaving static
// assets alone; public API routes pass through with session attach only.
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
