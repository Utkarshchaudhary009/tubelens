// Typed `SELECT 1` health probe behind the 8s fail-fast budget. Pure module
// (no `server-only` import) — unit-testable with a mocked sql client.
// Routes must use the bound `checkDbHealth()` from `./client` (server-only).

import {
  DB_FAIL_FAST_MS,
  DbConnectionError,
  type SqlClient,
  withDbTimeout,
} from "./factory";

export type DbHealthCode = "db_unavailable" | "db_timeout" | "db_error";

export type DbHealth =
  | { ok: true; latencyMs: number }
  | {
      ok: false;
      code: DbHealthCode;
      message: string;
      hint: string;
      status: 503 | 504;
    };

/**
 * Runs `SELECT 1` through the given sql getter. Degraded states are typed
 * (code + one-sentence hint + status) — never a bare 500, never a throw.
 */
export async function checkDbHealth(
  getSql: () => Promise<SqlClient>,
  timeoutMs: number = DB_FAIL_FAST_MS,
): Promise<DbHealth> {
  const started = Date.now();
  try {
    // The signal is threaded into the driver (fetchOptions.signal) so the
    // underlying Neon fetch is cancelled on timeout — not just the race.
    // A driver-side abort surfaces as AbortError and maps to db_timeout.
    await withDbTimeout(async (signal) => {
      const sql = await getSql();
      await sql.query("SELECT 1", [], { fetchOptions: { signal } });
    }, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof DbConnectionError) {
      return {
        ok: false,
        code: "db_unavailable",
        message: err.message,
        hint: err.hint,
        status: 503,
      };
    }
    if (
      err instanceof Error &&
      // AbortError can only come from this probe's own timeout signal, so
      // it is the same budget-exceeded outcome as the race gate's
      // TimeoutError — never a bare 500.
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      return {
        ok: false,
        code: "db_timeout",
        message: err.message,
        hint: "The database did not answer within the fail-fast budget; retry with backoff and check the Neon branch status.",
        status: 504,
      };
    }
    const message =
      err instanceof Error ? err.message : "Database health check failed";
    return {
      ok: false,
      code: "db_error",
      message,
      hint: "Retry with backoff; if this persists, check DATABASE_URL and the Neon project status.",
      status: 503,
    };
  }
}
