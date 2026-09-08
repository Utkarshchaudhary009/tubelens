// Resilient lazy-singleton cell for expensive shared resources (the
// Innertube session). Pure lib module (no server-only import) so the retry
// semantics are unit-testable; the server-only wiring lives in lib/youtube.
//
// Guarantees: concurrent callers share one in-flight creation; a rejected
// creation resets the cell so the next caller retries (in-flight awaiters
// still see the rejection); a hung creation is bounded by timeoutMs and
// likewise resets. A late rejection after a timeout win is observed and
// ignored (no unhandled rejections); timers are cleared on settle.

export interface LazySingleton<T> {
  get: () => Promise<T>;
  /** Drops the cached value so the next get() re-creates. */
  reset: () => void;
}

export function createLazySingleton<T>(
  create: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): LazySingleton<T> {
  let current: Promise<T> | null = null;
  const get = (): Promise<T> => {
    if (!current) {
      // Deferred so a synchronously-throwing create() enters the
      // rejection/reset path instead of escaping get() as a sync throw.
      const attempt = Promise.resolve().then(() => create());
      const gate = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          const err = new Error(`${timeoutMessage} after ${timeoutMs}ms`);
          err.name = "TimeoutError";
          reject(err);
        }, timeoutMs);
        // Late-settlement handler, independent of the race below: an
        // abandoned attempt (gate won, cell reset, replacement started)
        // that settles late is absorbed here — rejections never escape
        // unhandled — and always clears its timer.
        attempt.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      });
      // Race subscribes to `attempt`, so a late rejection after the gate
      // wins is observed (no unhandled rejection) and simply ignored.
      const pending: Promise<T> = Promise.race([attempt, gate]);
      current = pending;
      // Reset on failure so the next caller retries instead of reusing a
      // rejected promise forever.
      pending.catch(() => {
        if (current === pending) {
          current = null;
        }
      });
    }
    return current;
  };
  return {
    get,
    reset: () => {
      current = null;
    },
  };
}
