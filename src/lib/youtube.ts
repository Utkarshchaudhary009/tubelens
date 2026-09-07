import "server-only";
import { Innertube, UniversalCache } from "youtubei.js";

// Singleton Innertube session shared across all route handlers in one
// instance. Never instantiate per request — session creation is expensive
// and triggers upstream bot-guard friction.

type InnertubeInstance = Awaited<ReturnType<typeof Innertube.create>>;

let innertubePromise: Promise<InnertubeInstance> | null = null;

export function getInnertube(): Promise<InnertubeInstance> {
  if (!innertubePromise) {
    const config = {
      cache: new UniversalCache(false),
      lang: "en",
      location: "US",
      // Local session (no account) — supported by youtubei.js session options.
      generate_session_locally: true,
    } as unknown as Parameters<typeof Innertube.create>[0];
    const pending = Innertube.create(config);
    innertubePromise = pending;
    // Reset on failure so the next request retries instead of reusing a
    // rejected promise forever. In-flight awaiters still see the rejection.
    pending.catch(() => {
      if (innertubePromise === pending) {
        innertubePromise = null;
      }
    });
  }
  return innertubePromise;
}

/**
 * Fail-fast wrapper: youtubei.js has no per-call timeout, so race the task
 * against AbortSignal.timeout(ms) (default 8s per AGENTS.md checklist).
 * The signal is passed to the task for fetch-compatible calls; tasks that
 * ignore it are still bounded by the race.
 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms = 8000,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const err = new Error(`Upstream timed out after ${ms}ms`);
      err.name = "TimeoutError";
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([task(signal), gate]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
