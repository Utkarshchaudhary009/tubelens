import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasClerkSecret } from "./lib/clerk-auth";

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
export default function proxy(...args: Parameters<typeof runClerk>) {
  if (!hasClerkSecret()) {
    return NextResponse.next();
  }
  try {
    const out = runClerk(...args);
    if (out instanceof Promise) {
      return out.catch(() => NextResponse.next());
    }
    return out;
  } catch {
    return NextResponse.next();
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
