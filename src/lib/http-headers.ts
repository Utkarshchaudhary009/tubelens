// Phase 09 (HTTP hardening): security headers + CORS discipline for /api/v1.
// Centralized here so EVERY api response carries them: success envelope,
// typed errors, pipeline-stamped responses, and raw paths (openapi.json,
// RSS, audio bytes incl. 416). Never changes Cache-Control/Content-Type/
// X-Request-Id/X-RateLimit/Retry-After behavior — only adds headers.
//
// Production is HTTPS-only; Strict-Transport-Security is set unconditionally
// on API responses (harmless on http:// localhost previews).

import { NextResponse } from "next/server";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

/** Security headers applied to every /api/v1 response (incl. 4xx/5xx). */
export function securityHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}

/** Stamp security headers onto an existing Headers (never overwrites set values' intent — these are fixed values). */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

// ---------------------------------------------------------------------------
// CORS: never `*`; allowlist-only via TUBELENS_ALLOWED_ORIGINS.
// ---------------------------------------------------------------------------

/** Methods the API serves across preflighted routes (mirrors the [...notFound] catch-all). */
export const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
/** Request headers browser clients may send (Range: the audio gateway serves 206/416). */
export const ALLOW_HEADERS = "Authorization, Content-Type, Range, X-Request-Id";

/** Parse TUBELENS_ALLOWED_ORIGINS (comma-separated, exact match, trimmed). */
export function allowedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.TUBELENS_ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}

/** True when the origin is an exact allowlist entry. */
export function isAllowedOrigin(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return allowedOrigins(env).includes(origin.trim());
}

/**
 * CORS headers for a request origin. Returns {} when there is no Origin
 * header at all. A present-but-disallowed origin still gets `Vary: Origin`
 * (caches must not conflate the two verdicts) but no Allow-Origin grant —
 * the request is still served with same-origin semantics. Never emits `*`
 * and never sets Allow-Credentials.
 */
export function corsHeaders(
  origin: string | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!origin || origin.trim() === "") {
    return {};
  }
  const trimmed = origin.trim();
  if (!isAllowedOrigin(trimmed, env)) {
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": trimmed,
    Vary: "Origin",
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "600",
  };
}

/** Merge a Vary value without duplicating tokens (case-insensitive). */
function mergeVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  const seen = new Set(
    (existing ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
  const out = existing?.trim() ? [existing.trim()] : [];
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (trimmed !== "" && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      out.push(trimmed);
    }
  }
  headers.set("Vary", out.join(", "));
}

/**
 * Stamp CORS grant headers onto an existing Headers. Vary merges (never
 * clobbers a handler-set value); everything else sets. Effectively a no-op
 * for the grant when the origin is absent or disallowed — except Vary, which
 * is always stamped when an Origin was sent.
 */
export function applyCorsHeaders(
  headers: Headers,
  origin: string | null,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, value] of Object.entries(corsHeaders(origin, env))) {
    if (name.toLowerCase() === "vary") {
      mergeVary(headers, value);
    } else {
      headers.set(name, value);
    }
  }
}

/**
 * Shared preflight handler for /api/v1/* OPTIONS. Always 204 (never an
 * error): allowed origins get the CORS grant, disallowed origins get a 204
 * with Vary but without Allow-Origin. Security + tracing headers always apply.
 */
export function handlePreflight(
  req: { headers: { get(name: string): string | null } },
  requestId: string,
  env: Record<string, string | undefined> = process.env,
): NextResponse {
  const headers = new Headers();
  headers.set("X-Request-Id", requestId);
  applySecurityHeaders(headers);
  applyCorsHeaders(headers, req.headers.get("origin"), env);
  return new NextResponse(null, { status: 204, headers });
}

/** True for the API root and everything under it (bare /api/v1/ included). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/**
 * Pure preflight gate for the proxy short-circuit: browser OPTIONS against
 * any /api/v1 path (real or unknown) is answered centrally with
 * handlePreflight, so real routes never need per-route OPTIONS exports and
 * never fall through to a 405/HTML page.
 */
export function shouldPreflightRequest(req: {
  method: string;
  nextUrl: { pathname: string };
}): boolean {
  return req.method === "OPTIONS" && isApiPath(req.nextUrl.pathname);
}
