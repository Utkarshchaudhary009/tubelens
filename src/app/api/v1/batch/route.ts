import type { NextRequest, NextResponse } from "next/server";
import { isLoopbackHost, SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import { type BatchDeps, handleBatch } from "@/lib/utils";

export const runtime = "nodejs";

// Upstream seam: the default implementation re-enters a TRUSTED origin over
// HTTP (pinned via resolveBatchOrigin — explicit TUBELENS_PUBLIC_URL, Vercel
// VERCEL_URL, or loopback local dev; never the raw request Host, so
// Host-header poisoning cannot turn the fan-out into SSRF). Plain fetch, no
// youtubei singleton. Tests inject mocks here. Each item resolves via the
// JSON-only v1 allowlist with per-item error isolation; the batch itself is
// private, no-store.
//
// The sub-fetch runs through the SSRF boundary pinned to the first-hop
// origin host (handleBatch built the URL from the trusted origin +
// allowlisted path above): every redirect hop re-validates against THIS
// host, so a cross-origin Location cannot escape the fan-out. Loopback http
// is allowed only when the pinned origin itself is loopback local-dev.
const defaultDeps: BatchDeps = {
  async execute(url: string, requestId: string, signal?: AbortSignal) {
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
      allowLoopback: isLoopbackHost(originHost),
      timeoutMs: 8000,
      headers: { "x-request-id": requestId },
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleBatch(req, defaultDeps);
}
