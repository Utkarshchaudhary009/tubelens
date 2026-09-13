// Server-only Neon/Drizzle singleton for Vercel runtime.
//
// Importing this module never crashes when env is unset — DATABASE_URL is
// read lazily on first call and a missing value fails at call time with a
// typed DbConnectionError (503, never a bare 500). No plaintext secrets:
// both connection strings come from env / Vercel envs only.

import "server-only";
import { createDbStore, type Db, type SqlClient } from "./factory";
import { type DbHealth, checkDbHealth as probeDbHealth } from "./health";

const store = createDbStore();

export function getDb(): Promise<Db> {
  return store.getDb();
}

export function getSql(): Promise<SqlClient> {
  return store.getSql();
}

/**
 * Test-only hook — drops cached handles so the next call re-creates.
 * No-ops with a warning outside NODE_ENV=test so production singletons
 * cannot be reset by accident.
 */
export function resetDbForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    console.warn("resetDbForTests() is test-only; ignoring outside test env.");
    return;
  }
  store.reset();
}

/** Server-side `SELECT 1` probe behind the 8s fail-fast budget. */
export function checkDbHealth(): Promise<DbHealth> {
  return probeDbHealth(() => store.getSql());
}
