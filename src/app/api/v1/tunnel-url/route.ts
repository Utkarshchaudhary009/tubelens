import type { NextRequest } from "next/server";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import {
  handleTunnelGet,
  handleTunnelWrite,
  parseStoredTunnel,
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
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: pathname });
    const hit = blobs.find((b) => b.pathname === pathname) ?? blobs[0];
    if (!hit) {
      return null;
    }
    const res = await fetch(hit.url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
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
// bare GET is a 400 missing_name. Private, no-store — pointers change runs.
export async function GET(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const requestId = getRequestId(req);
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
