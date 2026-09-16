import type { NextRequest, NextResponse } from "next/server";
import { getRequestId } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { handlePreflight } from "@/lib/http-headers";

export const runtime = "nodejs";

// Phase 09: unknown /api/v1/* paths (plus bare /api/v1/ via the optional
// catch-all) return typed JSON 404 (never Next's default HTML 404) so
// browser and machine clients always get the envelope.
// Goes through errorResponse() so security headers + X-Request-Id stay
// consistent with every other response.
// NOTE: no HEAD export — framework HEAD semantics for Route Handlers are
// uncertain and API clients use GET; browsers preflight with OPTIONS
// (answered centrally in src/proxy.ts), never HEAD.
function notFound(req: NextRequest): NextResponse {
  const requestId = getRequestId(req);
  return errorResponse(requestId, {
    code: "not_found",
    message: "Unknown API path.",
    hint: "Check /api/v1/openapi.json for the list of available endpoints.",
    status: 404,
    origin: req.headers.get("origin"),
  });
}

export function GET(req: NextRequest): NextResponse {
  return notFound(req);
}

export function POST(req: NextRequest): NextResponse {
  return notFound(req);
}

export function PUT(req: NextRequest): NextResponse {
  return notFound(req);
}

export function PATCH(req: NextRequest): NextResponse {
  return notFound(req);
}

export function DELETE(req: NextRequest): NextResponse {
  return notFound(req);
}

export function OPTIONS(req: NextRequest): NextResponse {
  return handlePreflight(req, getRequestId(req));
}
