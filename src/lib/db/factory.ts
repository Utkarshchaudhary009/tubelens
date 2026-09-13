// Pure DB store factory (no `server-only` import) so laziness, missing-env,
// and timeout semantics are unit-testable under bun:test. The server-only
// boundary lives in `./client`, which binds the default store.
//
// Fail-fast pattern mirrors `../youtube.ts` `withTimeout`
// (AbortSignal.timeout race, tasks still bounded if they ignore the signal).

import { type NeonQueryFunction, neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { createLazySingleton } from "../singleton";

/** Fail-fast budget for DB work (AGENTS.md route checklist: 8s). */
export const DB_FAIL_FAST_MS = 8000;

export type SqlClient = NeonQueryFunction<false, false>;
export type Db = NeonHttpDatabase;

/** Typed degraded failure when the DB is not configured. Never a bare 500. */
export class DbConnectionError extends Error {
  readonly code = "db_unavailable" as const;
  readonly hint: string;
  readonly status = 503 as const;

  constructor(
    message = "Database is not configured",
    hint = "Set the pooled DATABASE_URL env var (Neon pooled connection string) and retry; see .env.example.",
  ) {
    super(message);
    this.name = "DbConnectionError";
    this.hint = hint;
  }
}

export interface DbDeps {
  readDatabaseUrl: () => string | undefined;
  createSql: (url: string) => SqlClient;
  createDb: (sql: SqlClient) => Db;
}

export const defaultDbDeps: DbDeps = {
  // Pooled DATABASE_URL is for runtime; DATABASE_DIRECT_URL is for
  // `bun run db:migrate` only and is never read here.
  readDatabaseUrl: () => process.env.DATABASE_URL,
  createSql: (url) => neon(url),
  createDb: (sql) => drizzle(sql),
};

export interface DbHandles {
  db: Db;
  sql: SqlClient;
}

export interface DbStore {
  getDb: () => Promise<Db>;
  getSql: () => Promise<SqlClient>;
  /** Drops cached handles so the next call re-creates (test hook). */
  reset: () => void;
}

/**
 * Lazy singleton store: the first call reads env + builds the clients once,
 * concurrent callers share one in-flight creation, and a missing
 * DATABASE_URL fails at call time (never at import) with DbConnectionError.
 */
export function createDbStore(
  deps: DbDeps = defaultDbDeps,
  timeoutMs: number = DB_FAIL_FAST_MS,
): DbStore {
  const cell = createLazySingleton<DbHandles>(
    async () => {
      // Whitespace-only counts as missing: fail typed instead of letting
      // the driver throw a raw error on a blank connection string.
      const url = deps.readDatabaseUrl()?.trim();
      if (!url) {
        throw new DbConnectionError();
      }
      const sql = deps.createSql(url);
      return { db: deps.createDb(sql), sql };
    },
    timeoutMs,
    "Database connection timed out",
  );
  return {
    getDb: async () => (await cell.get()).db,
    getSql: async () => (await cell.get()).sql,
    reset: () => cell.reset(),
  };
}

/** Same AbortSignal.timeout race as `../youtube.ts` `withTimeout`. */
export async function withDbTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number = DB_FAIL_FAST_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const err = new Error(`Database timed out after ${ms}ms`);
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
