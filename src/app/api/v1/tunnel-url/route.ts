import type { NextRequest } from "next/server";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { safeFetch } from "@/lib/safe-fetch";
import {
  handleTunnelGet,
  handleTunnelWrite,
  parseStoredTunnel,
  resolveSlot,
  type TunnelDeps,
  type TunnelRecord,
  type TunnelSlot,
  type TunnelStore,
  tunnelBlobPath,
} from "@/lib/tunnel-url";

export const runtime = "nodejs";

// Vercel Blob pointers for throwaway tunnel URLs (one blob per `name` slot:
// `tunnel-url-t3.json`, `tunnel-url-transcript.json`). @vercel/blob is
// imported lazily so this module stays importable without Blob credentials
// (tests inject mock stores into the lib handlers and never touch Blob).
const blobStore: TunnelStore = {
  async read(slot: TunnelSlot) {
    const pathname = tunnelBlobPath(slot);
    const { head } = await import("@vercel/blob");
    // `head` hits the Blob API directly (never the CDN), so it always sees
    // the latest write — `list` + bare fetch can replay a stale edge copy
    // for up to ~60s after a re-publish. A missing blob is "none", not 502.
    let url: string;
    try {
      url = (await head(pathname)).url;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "BlobNotFoundError" || /not[ -]?found/i.test(err.message))
      ) {
        return null;
      }
      throw err;
    }
    // Content still comes from the CDN URL, so bust the edge cache: unique
    // query per read + explicit no-cache request headers + no-store mode.
    // The stored Blob URL is re-validated through the SSRF boundary (https +
    // Vercel Blob host allowlist, redirect hops re-checked) before fetching:
    // a poisoned pointer can never pull the read off-host.
    const sep = url.includes("?") ? "&" : "?";
    const res = await safeFetch(`${url}${sep}t=${Date.now()}`, {
      allowHosts: [/\.blob\.vercel-storage\.com$/],
      timeoutMs: 8000,
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`tunnel blob fetch failed: ${res.status}`);
    }
    return parseStoredTunnel((await res.json()) as unknown);
  },
  async write(slot: TunnelSlot, rec: TunnelRecord) {
    const { put } = await import("@vercel/blob");
    await put(tunnelBlobPath(slot), JSON.stringify(rec), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return rec;
  },
};

function deps(): TunnelDeps {
  return { store: blobStore, expectedToken: process.env.TUNNEL_UPDATE_TOKEN };
}

// Public read: { data: { url, runId, updatedAt } } or { data: null } when no
// run has published that slot yet. `?name=` is required (no default slot):
// bare GET is a 400 missing_name — validated BEFORE the blob-unconfigured
// early-out so an invalid slot never returns 200 null. Private, no-store.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const slot = resolveSlot(req.nextUrl.searchParams.get("name"));
  if (!slot.ok) {
    return errorResponse(requestId, slot.error);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return successResponse(null, {
      requestId,
      cacheControl: CACHE_CONTROL.noStore,
      warnings: [
        {
          code: "blob_unconfigured",
          message:
            "Blob store is not connected, so no tunnel URL is available.",
        },
      ],
    });
  }
  return handleTunnelGet(req, deps());
}

// Publisher write: bearer-gated overwrite of one slot's pointer. `name` is
// required (JSON body field or ?name= query param). PUT is an alias.
export async function POST(req: NextRequest) {
  return handleTunnelWrite(req, deps());
}

export async function PUT(req: NextRequest) {
  return handleTunnelWrite(req, deps());
}
