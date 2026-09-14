import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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

function hasClerkKeys(): boolean {
  return (
    (process.env.CLERK_SECRET_KEY ?? "").trim() !== "" &&
    (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").trim() !== ""
  );
}

// Keyless-safe degrade: without Clerk keys (local unit tests,
// unconfigured envs) skip Clerk entirely — public routes keep serving and
// protected routes still deny via the anonymous provider + `requireAuth()`.
export default function proxy(...args: Parameters<typeof runClerk>) {
  if (!hasClerkKeys()) {
    return NextResponse.next();
  }
  return runClerk(...args);
}

// Covers /api/v1/me (and future protected routes) while leaving static
// assets alone; public API routes pass through with session attach only.
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
