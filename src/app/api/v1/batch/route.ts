import type { NextRequest, NextResponse } from "next/server";
import { type BatchDeps, handleBatch } from "@/lib/utils";

export const runtime = "nodejs";

// Upstream seam: the default implementation re-enters a TRUSTED origin over
// HTTP (pinned via resolveBatchOrigin — explicit TUBELENS_PUBLIC_URL, Vercel
// VERCEL_URL, or loopback local dev; never the raw request Host, so
// Host-header poisoning cannot turn the fan-out into SSRF). Plain fetch, no
// youtubei singleton. Tests inject mocks here. Each item resolves via the
// JSON-only v1 allowlist with per-item error isolation; the batch itself is
// private, no-store.
const defaultDeps: BatchDeps = {
  async execute(url: string, requestId: string, signal?: AbortSignal) {
    // Per-call 8s fail-fast AND the batch shared deadline (whichever fires
    // first aborts the sub-fetch).
    const timeout = AbortSignal.timeout(8000);
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { "x-request-id": requestId },
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
