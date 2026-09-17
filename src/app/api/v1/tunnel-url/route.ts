import type { NextRequest } from "next/server";
import { CACHE_CONTROL, getRequestId, successResponse } from "@/lib/envelope";
import { errorResponse } from "@/lib/errors";
import { readTunnelRecord } from "@/lib/tunnel-blob";
import {
  handleTunnelGet,
  handleTunnelWrite,
  resolveSlot,
  type TunnelDeps,
  type TunnelRecord,
  type TunnelSlot,
  type TunnelStore,
  tunnelBlobPath,
} from "@/lib/tunnel-url";

export const runtime = "nodejs";

// Mutable tunnel pointers are tiny JSON objects that are overwritten in
// place. Keep the Blob CDN cache hot for 7 hours so repeated reads mostly hit
// the CDN instead of Blob origin. Vercel invalidates overwritten blob content
// through its cache, with documented propagation of up to ~60 seconds.
const TUNNEL_BLOB_CACHE_MAX_AGE = 7 * 60 * 60;

// Vercel Blob pointers for throwaway tunnel URLs (one blob per `name` slot:
// `tunnel-url-t3.json`, `tunnel-url-transcript.json`). Reads go through the
// shared lib helper (same read the /dev/t3 page uses directly — no HTTP
// self-fetch); @vercel/blob `put` stays lazy so this module is importable
// without Blob credentials (tests inject mock stores and never touch Blob).
const blobStore: TunnelStore = {
  read: (slot: TunnelSlot) => readTunnelRecord(slot),
  async write(slot: TunnelSlot, rec: TunnelRecord) {
    const { put } = await import("@vercel/blob");
    await put(tunnelBlobPath(slot), JSON.stringify(rec), {
      // The connected Vercel Blob store is configured as private. Keep the
      // pointer private and read it server-side with the Blob SDK.
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: TUNNEL_BLOB_CACHE_MAX_AGE,
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
// early-out so an invalid slot never returns 200 null. The API response itself
// remains no-store because it contains the current pairing credential; the
// underlying private Blob fetch is separately CDN-cached for cost control.
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
