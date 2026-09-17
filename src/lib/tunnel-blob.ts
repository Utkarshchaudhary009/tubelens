// Direct server-side read of tunnel-slot Blob pointers (Part B Phase 10).
//
// The tunnel-url route AND the /dev/t3 page both read through here instead
// of the page self-fetching its own API over HTTP from a Host-derived URL
// (that pattern trusts the request Host header for a server-side fetch).
// The connected Vercel Blob store is private, so reads use the Blob SDK's
// authenticated private access path rather than fetching a public CDN URL.

import {
  parseStoredTunnel,
  type TunnelRecord,
  type TunnelSlot,
  tunnelBlobPath,
} from "@/lib/tunnel-url";

/**
 * Reads one slot's stored tunnel record, or null when no run has published
 * it yet. Uses the private Blob SDK path and bypasses Blob/CDN cache so a
 * freshly published tunnel pointer is visible immediately to /dev/t3.
 * Throws on Blob/upstream failures (callers map to typed 502s).
 */
export async function readTunnelRecord(
  slot: TunnelSlot,
): Promise<TunnelRecord | null> {
  const pathname = tunnelBlobPath(slot);
  const { get } = await import("@vercel/blob");
  // `get` authenticates with the configured BLOB_READ_WRITE_TOKEN for the
  // private store. `useCache: false` guarantees the latest pointer after a
  // runner republishes the same pathname.
  const result = await get(pathname, {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode === 404) {
    return null;
  }
  if (result.statusCode !== 200) {
    throw new Error(`tunnel blob fetch failed: ${result.statusCode}`);
  }
  return parseStoredTunnel(await new Response(result.stream).json());
}
