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
    await withDbTimeout(async () => {
      const sql = await getSql();
      await sql`SELECT 1`;
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
    if (err instanceof Error && err.name === "TimeoutError") {
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
