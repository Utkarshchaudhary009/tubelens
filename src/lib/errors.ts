import { NextResponse } from "next/server";
import { baseHeaders, CACHE_CONTROL } from "./envelope";

// Typed error-with-hint responses per plans/DX_PRINCIPLES.md:
//   { error: { code, message, hint, status } } — never stack traces.

export interface ApiErrorOptions {
  code: string;
  message: string;
  /** One actionable sentence telling the caller what to do next. */
  hint: string;
  status: number;
  /** Seconds — set on 429 rate_limited responses. */
  retryAfter?: number;
}

export function errorResponse(
  requestId: string,
  opts: ApiErrorOptions,
): NextResponse {
  const body = {
    error: {
      code: opts.code,
      message: opts.message,
      hint: opts.hint,
      status: opts.status,
    },
    // Header/body parity per contract: meta.requestId mirrors X-Request-Id
    // on every response, success or typed error.
    meta: { requestId },
  };
  const headers = baseHeaders(requestId);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", CACHE_CONTROL.noStore);
  if (opts.retryAfter !== undefined) {
    headers.set("Retry-After", String(opts.retryAfter));
  } else if (opts.status === 429) {
    // 429s MUST always carry Retry-After; default when the caller omits it.
    headers.set("Retry-After", "60");
  }
  return new NextResponse(JSON.stringify(body), {
    status: opts.status,
    headers,
  });
}
