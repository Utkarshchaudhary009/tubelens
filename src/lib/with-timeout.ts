// Shared AbortSignal.timeout race used by fail-fast wrappers (lib/youtube
// `withTimeout`, lib/db `withDbTimeout`). Pure module (no server-only
// import) so both server and pure callers can share it.
//
// Semantics: races `task(signal)` against AbortSignal.timeout(ms); tasks
// that ignore the signal are still bounded by the race. Timeout failures
// reject with `name: "TimeoutError"` and the caller-supplied message.

export async function raceWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const err = new Error(timeoutMessage);
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
