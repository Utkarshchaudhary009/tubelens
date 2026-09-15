import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isT3PairingUrl } from "@/lib/tunnel-url";

// /dev/t3 — bounce the browser straight into the live T3 remote-dev session.
//
// CRITICAL OTP catch: `npx t3 serve` prints a FULL pairing URL,
// `http://127.0.0.1:3773/pair#token=<16-char code>` (alphabet
// 23456789ABCDEFGHJKLMNPQRSTUVWXYZ, ~5min TTL). The `#token=` hash fragment
// never reaches any server — the browser consumes it locally and auto-pairs.
// There is no --auth-token flag and no short numeric OTP, so the remote-t3
// workflow host-swaps that pairing URL onto the tunnel host and POSTs the
// whole thing (fragment included) to the `t3` tunnel slot. This page must
// redirect to that FULL pairing URL — redirecting to the bare tunnel root
// lands on manual token entry instead.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Staleness guard: the /pair#token= fragment expires ~5 min after minting,
// and every successful workflow publish (initial capture or re-mint loop)
// refreshes the slot's server-set `updatedAt`. Past this age auto-pairing
// has likely expired, so the page shows the stale warning (with a manual
// click-through link, fail-open) instead of redirecting into a dead token.
// Kept slightly above the ~5 min TTL as grace for clock skew.
const STALE_AFTER_MS = 6 * 60 * 1000;

interface TunnelSlotPayload {
  data: { url: string; runId: string; updatedAt: string } | null;
}

async function getPairingRecord(): Promise<TunnelSlotPayload["data"]> {
  const h = await headers();
  const host =
    h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  if (!host) {
    return null;
  }
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (process.env.NODE_ENV === "development" ? "http" : "https");
  try {
    const res = await fetch(`${proto}://${host}/api/v1/tunnel-url?name=t3`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as TunnelSlotPayload;
    return body.data;
  } catch {
    return null;
  }
}

export default async function DevT3Page() {
  const rec = await getPairingRecord();
  // Only redirect to a genuine pairing URL (quick-tunnel host +
  // /pair#token=). The stored value is publisher-supplied, so anything else
  // falls through to the holding page instead of open-redirecting.
  if (rec?.url && isT3PairingUrl(rec.url)) {
    const ageMs = Date.now() - Date.parse(rec.updatedAt);
    if (!Number.isNaN(ageMs) && ageMs <= STALE_AFTER_MS) {
      redirect(rec.url);
    }
    // Fresh-looking shape but expired token: stale warning below (fail-open
    // with a manual click-through link) instead of a dead-token redirect.
    const ageMin = Number.isNaN(ageMs)
      ? "unknown"
      : `${Math.floor(ageMs / 60000)}`;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 p-8 text-center dark:bg-black">
        <meta httpEquiv="refresh" content="15" />
        <h1 className="text-2xl font-semibold">T3 pairing may be stale</h1>
        <p className="max-w-md text-zinc-600 dark:text-zinc-400">
          The stored pairing token is {ageMin} min old (auto-pair tokens expire
          after ~5 min). The workflow re-mints it every ~4 min — wait a moment
          and this page will redirect on its own (it retries every 15 seconds).
        </p>
        <p className="max-w-md text-zinc-600 dark:text-zinc-400">
          <a className="underline" href={rec.url}>
            Try the pairing URL anyway
          </a>{" "}
          (lands on manual token entry if the token already expired), or start a
          fresh session via GitHub → Actions → <code>remote-t3</code> → Run
          workflow.
        </p>
        <p className="max-w-md text-sm text-zinc-500">
          Slot status:{" "}
          <a
            className="underline"
            href="/api/v1/tunnel-url?name=t3"
          >{`/api/v1/tunnel-url?name=t3`}</a>
        </p>
      </main>
    );
  }
  // No session published (yet): show a self-refreshing holding page instead
  // of 404ing — the workflow can appear at any time. React 19 hoists this
  // <meta> into <head>, so the refresh actually fires.
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 p-8 text-center dark:bg-black">
      <meta httpEquiv="refresh" content="15" />
      <h1 className="text-2xl font-semibold">No live T3 session</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Nothing has published to the <code>t3</code> tunnel slot yet. Start one
        via GitHub → Actions → <code>remote-t3</code> → Run workflow, then this
        page will auto-redirect into the pairing URL (this page retries every 15
        seconds).
      </p>
      <p className="max-w-md text-sm text-zinc-500">
        Slot status:{" "}
        <a
          className="underline"
          href="/api/v1/tunnel-url?name=t3"
        >{`/api/v1/tunnel-url?name=t3`}</a>
      </p>
    </main>
  );
}
