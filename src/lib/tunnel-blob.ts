// Direct server-side read of tunnel-slot Blob pointers (Part B Phase 10).
//
// The tunnel-url route AND the /dev/t3 page both read through here instead
// of the page self-fetching its own API over HTTP from a Host-derived URL
// (that pattern trusts the request Host header for a server-side fetch).
// Pure lib module (no server-only import): @vercel/blob is imported lazily
// so unit tests stay offline, and the CDN read runs through the SSRF
// boundary (https + Vercel Blob host allowlist, redirects re-validated).

import { safeFetch } from "@/lib/safe-fetch";
import {
  parseStoredTunnel,
  type TunnelRecord,
  type TunnelSlot,
  tunnelBlobPath,
} from "@/lib/tunnel-url";

/** Blob pathname errors that mean "no pointer published yet" (not a 502). */
function isNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "BlobNotFoundError" || /not[ -]?found/i.test(err.message))
  );
}

/**
 * Reads one slot's stored tunnel record, or null when no run has published
 * it yet. Throws on Blob/upstream failures (callers map to typed 502s).
 */
export async function readTunnelRecord(
  slot: TunnelSlot,
): Promise<TunnelRecord | null> {
  const pathname = tunnelBlobPath(slot);
  const { head } = await import("@vercel/blob");
  // `head` hits the Blob API directly (never the CDN), so it always sees
  // the latest write — `list` + bare fetch can replay a stale edge copy
  // for up to ~60s after a re-publish. A missing blob is "none", not 502.
  let url: string;
  try {
    url = (await head(pathname)).url;
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
  // Content still comes from the CDN URL, so bust the edge cache: unique
  // query per read + explicit no-cache request headers + no-store mode. The
  // stored Blob URL is re-validated through the SSRF boundary before
  // fetching: a poisoned pointer can never pull the read off-host.
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
  return parseStoredTunnel(await res.json());
}
