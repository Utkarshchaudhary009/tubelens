// Phase 16: already-billed batch-child marker.
//
// A batch parent is admitted ONCE through the pipeline with the summed
// child cost. Its children re-enter the app as same-origin loopback
// sub-requests — without a marker those would be admitted AGAIN (double
// charge on top of the summed cost once every data route is pipeline-wired
// (tracked follow-up #34). Each child therefore carries an HMAC proving the
// server minted it for exactly this method + path; the pipeline verifies
// the marker and skips the child's rate-limit/quota/usage stages.
//
// Unforgeability: the key is server-only (never logged, never sent). A
// forged or missing marker is IGNORED — the request falls through to normal
// admission (fail toward charging, never toward free serving). Markers never
// leave the server: child responses embed only {status, body}, so clients
// cannot observe or replay them; binding the MAC to the exact child path
// further confines any leaked marker to that one path.
//
// Key source ($0, no new required infra): dedicated
// TUBELENS_BATCH_HMAC_KEY wins, CLERK_SECRET_KEY is the fallback (present in
// any identity-enforcing deployment — exactly where quota matters). No key
// configured → children unsigned and admitted normally (documented
// limitation, not a bypass: nothing becomes free).
//
// Rotation/expiry note: markers deliberately carry no timestamp — they are
// minted and verified within a single batch fan-out (milliseconds apart)
// and never leave the server, so there is no replay window to bound and no
// clock-skew to manage. Rotation is a two-step redeploy: set the new key
// as TUBELENS_BATCH_HMAC_KEY and the old one as
// TUBELENS_BATCH_HMAC_PREVIOUS_KEY (verification accepts both, so a parent
// admitted pre-redeploy still has its children honored when loopback lands
// them on a new instance), then drop the previous key once no pre-rotation
// batch can still be in flight. If markers ever outlive a request (e.g.
// queued children), bind the monthly quota windowId or calendar day into
// the payload and reject stale epochs at verify time.
//
// Pure and server-only-safe: no `import "server-only"` (unconditionally
// throws under bun — same rationale as quota.ts/rate-limit.ts); the
// no-client guarantee comes from the import graph (Route Handlers only).

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the already-billed marker on batch-child sub-requests. */
export const BATCH_CHILD_HEADER = "x-tubelens-batch-child";

/**
 * Internal partial-success signal: `executeBatchTasks` sets it on the
 * admitted 200 when any child result is status >= 400, and the pipeline
 * reads it for the usage row's `partial` outcome, then STRIPS it — never
 * part of the wire contract. Read from the handler-built RESPONSE only, so
 * client request headers can never inject it.
 */
export const BATCH_PARTIAL_HEADER = "x-tubelens-batch-partial";

const HMAC_DOMAIN = "tubelens-batch-child:v1";

type Env = Record<string, string | undefined>;

/**
 * All verification secrets: the current dedicated key, the previous
 * dedicated key (rotation window — a parent admitted pre-redeploy signs
 * with the old key while its loopback children may land on a new instance
 * already reading the new one), then the Clerk fallback. First-non-blank
 * per slot (same alias rule as config.ts); blanks dropped, duplicates
 * collapsed. Minting always uses element zero.
 */
export function getBatchMarkerSecrets(env: Env): string[] {
  const out: string[] = [];
  for (const raw of [
    env.TUBELENS_BATCH_HMAC_KEY,
    env.TUBELENS_BATCH_HMAC_PREVIOUS_KEY,
    env.CLERK_SECRET_KEY,
  ]) {
    const secret = (raw ?? "").trim();
    if (secret !== "" && !out.includes(secret)) {
      out.push(secret);
    }
  }
  return out;
}

/**
 * Resolve the marker signing secret (element zero of
 * {@link getBatchMarkerSecrets}); null when unconfigured (children
 * unsigned, normal admission).
 */
export function getBatchMarkerSecret(env: Env): string | null {
  return getBatchMarkerSecrets(env)[0] ?? null;
}

function payload(method: string, pathQuery: string): string {
  return `${HMAC_DOMAIN}\n${method}\n${pathQuery}`;
}

/** Mint a marker for one child request (hex HMAC-SHA256, sync). */
export function mintBatchChildMarker(
  secret: string,
  method: string,
  pathQuery: string,
): string {
  return createHmac("sha256", secret)
    .update(payload(method, pathQuery))
    .digest("hex");
}

/**
 * Verify a presented marker. False on ANY doubt (malformed hex, wrong
 * length, MAC mismatch, empty secret) — callers treat false as "no marker".
 */
export function verifyBatchChildMarker(
  secret: string,
  method: string,
  pathQuery: string,
  marker: string,
): boolean {
  if (secret === "" || !/^[0-9a-f]{64}$/i.test(marker)) {
    return false;
  }
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = createHmac("sha256", secret)
      .update(payload(method, pathQuery))
      .digest();
    actual = Buffer.from(marker, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
