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
 * it yet. Uses the private Blob SDK's normal cached read path.
 *
 * The blob is overwritten in-place with a 7-hour CDN cache policy. Vercel
 * documents that overwrites can take up to 60 seconds to propagate through
 * the cache; cache HITs avoid Simple Operations and Fast Origin Transfer.
 *
 * Throws on Blob/upstream failures (callers map to typed 502s).
 */
export async function readTunnelRecord(
  slot: TunnelSlot,
): Promise<TunnelRecord | null> {
  const pathname = tunnelBlobPath(slot);
  const { get } = await import("@vercel/blob");
  // Leave caching enabled. In @vercel/blob 2.6+, useCache defaults to true;
  // explicit true documents that this hot path should use the Blob CDN cache.
  const result = await get(pathname, {
    access: "private",
    useCache: true,
  });
  if (!result || result.statusCode !== 200) {
    return null;
  }
  return parseStoredTunnel(await new Response(result.stream).json());
}
