// Phase 00 — Neon Postgres plumbing (no real network; injectable deps).
//
// Covers: singleton laziness, missing-env degraded behavior, SELECT 1
// success via a mocked sql client, forced-timeout bounded failure,
// server-only boundary note, secret scan, and the no-payload-cache-table
// assertion over drizzle/.
//
// NOTE on the server-only boundary: `src/lib/db/client.ts` carries
// `import "server-only"`, which throws outside React Server Components, so
// bun:test cannot import it directly. The boundary is asserted statically
// below (source contains the import), while behavior is tested through the
// pure `./factory` / `./health` modules the client binds.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPlaceholderLine, SECRET_SCAN_PATTERNS } from "../../redact";
import {
  createDbStore,
  DB_FAIL_FAST_MS,
  type Db,
  DbConnectionError,
  type DbDeps,
  defaultDbDeps,
  type SqlClient,
} from "../factory";
import { checkDbHealth } from "../health";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DB_DIR = resolve(import.meta.dir, "..");

const savedDatabaseUrl = process.env.DATABASE_URL;
const savedDirectUrl = process.env.DATABASE_DIRECT_URL;

afterEach(() => {
  if (savedDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = savedDatabaseUrl;
  }
  if (savedDirectUrl === undefined) {
    delete process.env.DATABASE_DIRECT_URL;
  } else {
    process.env.DATABASE_DIRECT_URL = savedDirectUrl;
  }
});

interface MockSqlQuery {
  text: string;
  signal: AbortSignal | undefined;
}

function mockSql(
  impl: (text: string) => Promise<unknown> = async () => [{ "?column?": 1 }],
  queries?: MockSqlQuery[],
): SqlClient {
  const record = (text: string, signal: AbortSignal | undefined) => {
    queries?.push({ text, signal });
  };
  const fn = Object.assign(
    async (
      _strings: TemplateStringsArray,
      ..._params: unknown[]
    ): Promise<unknown> => {
      record("<template>", undefined);
      return impl("<template>");
    },
    {
      query: async (
        text: string,
        _params?: unknown[],
        queryOpts?: { fetchOptions?: { signal?: AbortSignal } },
      ): Promise<unknown> => {
        const signal = queryOpts?.fetchOptions?.signal;
        record(text, signal);
        return impl(text);
      },
    },
  );
  return fn as unknown as SqlClient;
}

function mockDeps(overrides: Partial<DbDeps> = {}): DbDeps & {
  calls: { createSql: number; createDb: number };
} {
  const calls = { createSql: 0, createDb: 0 };
  const sql = mockSql();
  return {
    calls,
    readDatabaseUrl: () => "postgresql://mock-user@localhost:5432/mockdb",
    createSql: (_url: string) => {
      calls.createSql += 1;
      return sql;
    },
    createDb: (_sql: SqlClient) => {
      calls.createDb += 1;
      return {} as Db;
    },
    ...overrides,
  };
}

describe("db store", () => {
  test("lazy singleton: one creation shared across calls, reset re-creates", async () => {
    const deps = mockDeps();
    const store = createDbStore(deps);
    const first = await store.getDb();
    const second = await store.getDb();
    expect(second).toBe(first);
    expect(deps.calls.createSql).toBe(1);
    expect(deps.calls.createDb).toBe(1);
    store.reset();
    await store.getDb();
    expect(deps.calls.createSql).toBe(2);
  });

  test("missing DATABASE_URL fails at call time with a typed 503", async () => {
    const deps = mockDeps({ readDatabaseUrl: () => undefined });
    const store = createDbStore(deps);
    const err = await store
      .getDb()
      .then((): unknown => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as DbConnectionError).code).toBe("db_unavailable");
    expect((err as DbConnectionError).status).toBe(503);
    expect((err as DbConnectionError).hint.length).toBeGreaterThan(0);
    // Never attempted to build a client.
    expect(deps.calls.createSql).toBe(0);
  });

  test("whitespace-only DATABASE_URL counts as missing (typed 503)", async () => {
    const deps = mockDeps({ readDatabaseUrl: () => "   " });
    const store = createDbStore(deps);
    const err = await store
      .getDb()
      .then((): unknown => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbConnectionError);
    expect((err as DbConnectionError).code).toBe("db_unavailable");
    expect(deps.calls.createSql).toBe(0);
  });

  test("default deps read the pooled DATABASE_URL from env", () => {
    process.env.DATABASE_URL = "postgresql://pooled-test/db";
    expect(defaultDbDeps.readDatabaseUrl()).toBe("postgresql://pooled-test/db");
    delete process.env.DATABASE_URL;
    expect(defaultDbDeps.readDatabaseUrl()).toBeUndefined();
  });
});

describe("checkDbHealth", () => {
  test("SELECT 1 success via mocked sql client", async () => {
    const deps = mockDeps();
    const store = createDbStore(deps);
    const health = await checkDbHealth(() => store.getSql());
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("missing env degrades without touching the network", async () => {
    const deps = mockDeps({ readDatabaseUrl: () => undefined });
    const store = createDbStore(deps);
    const health = await checkDbHealth(() => store.getSql());
    expect(health).toMatchObject({
      ok: false,
      code: "db_unavailable",
      status: 503,
    });
    if (!health.ok) {
      expect(health.hint.length).toBeGreaterThan(0);
    }
    expect(deps.calls.createSql).toBe(0);
  });

  test("probe threads the abort signal into the driver query", async () => {
    const queries: MockSqlQuery[] = [];
    const deps = mockDeps({
      createSql: (_url: string) =>
        mockSql(async () => [{ "?column?": 1 }], queries),
    });
    const store = createDbStore(deps);
    const health = await checkDbHealth(() => store.getSql());
    expect(health.ok).toBe(true);
    expect(queries.length).toBe(1);
    expect(queries[0]?.text).toBe("SELECT 1");
    expect(queries[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(queries[0]?.signal?.aborted).toBe(false);
  });

  test("forced timeout fails bounded well under the 8s budget", async () => {
    const hanging = () => new Promise<never>(() => {});
    const deps = mockDeps({
      createSql: (_url: string) => mockSql(hanging),
    });
    const store = createDbStore(deps);
    const started = Date.now();
    const health = await checkDbHealth(() => store.getSql(), 25);
    const elapsed = Date.now() - started;
    expect(health).toMatchObject({ ok: false, code: "db_timeout" });
    expect(elapsed).toBeLessThan(2000);
  });

  test("driver-side abort maps to typed db_timeout (never a bare 500)", async () => {
    // Simulate a driver that already observed cancellation: reject
    // immediately with an AbortError-named error instead of waiting for the
    // signal's abort event. Waiting for the event would register this mock's
    // listener AFTER withDbTimeout's internal gate listener on the same
    // AbortSignal.timeout() signal, so the gate's TimeoutError would always
    // settle the Promise.race first and the AbortError branch would never be
    // covered. Immediate rejection wins the race deterministically.
    const captured: { signal?: AbortSignal } = {};
    const deps = mockDeps({
      createSql: (_url: string) => {
        const fn = Object.assign(
          async (): Promise<unknown> => [{ "?column?": 1 }],
          {
            query: async (
              _text: string,
              _params?: unknown[],
              queryOpts?: { fetchOptions?: { signal?: AbortSignal } },
            ): Promise<unknown> => {
              const signal = queryOpts?.fetchOptions?.signal;
              captured.signal = signal;
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              throw err;
            },
          },
        );
        return fn as unknown as SqlClient;
      },
    });
    const store = createDbStore(deps);
    const health = await checkDbHealth(() => store.getSql(), 25);
    expect(health).toMatchObject({
      ok: false,
      code: "db_timeout",
      status: 504,
    });
    expect(captured.signal).toBeInstanceOf(AbortSignal);
  });

  test("default fail-fast budget is 8s", () => {
    expect(DB_FAIL_FAST_MS).toBe(8000);
  });
});

describe("server-only boundary (static note)", () => {
  test("client.ts holds the server-only boundary; factory/health stay pure", () => {
    const client = readFileSync(join(DB_DIR, "client.ts"), "utf8");
    expect(client).toContain('import "server-only"');
    for (const name of [
      "getDb",
      "getSql",
      "resetDbForTests",
      "checkDbHealth",
    ]) {
      expect(client).toContain(name);
    }
    expect(readFileSync(join(DB_DIR, "factory.ts"), "utf8")).not.toContain(
      'import "server-only"',
    );
    expect(readFileSync(join(DB_DIR, "health.ts"), "utf8")).not.toContain(
      'import "server-only"',
    );
  });
});

function repoTextFiles(): string[] {
  // Scan Git-tracked files only: a developer following the documented
  // workflow keeps a real DATABASE_URL in gitignored `.env.local`, which
  // must never fail the suite — only committed code is scanned. When git
  // is unavailable, fall back to the directory walk (same skips).
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\0")
      .filter((f) => f.length > 0)
      .map((f) => join(REPO_ROOT, f))
      .filter((f) => underSizeLimit(f));
  } catch {
    return walkRepoFiles();
  }
}

function underSizeLimit(full: string): boolean {
  try {
    return statSync(full).size <= 1024 * 1024;
  } catch {
    return false;
  }
}

function walkRepoFiles(): string[] {
  const skipDirs = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
  ]);
  const skipFiles = (name: string) =>
    name === ".env" || name.startsWith(".env.");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (skipFiles(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (underSizeLimit(full)) {
        out.push(full);
      }
    }
  };
  walk(REPO_ROOT);
  return out;
}

describe("secret scan", () => {
  test("no credential-shaped database URL literal lives in repo files", () => {
    // The database-URL shape is SECRET_SCAN_PATTERNS[0]; the remaining
    // value shapes are covered by the shippable-source scan below. Kept as
    // its own full-repo assertion (including fixtures) because a committed
    // credential URL is severe wherever it sits.
    const credentialUrl = SECRET_SCAN_PATTERNS[0];
    const hits: string[] = [];
    for (const file of repoTextFiles()) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        credentialUrl.lastIndex = 0;
        if (credentialUrl.test(line) && !isPlaceholderLine(line)) {
          hits.push(`${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("no secret-shaped token or assignment lives in shippable source", () => {
    // Phase 11: extends the scan to the centralized value shapes
    // (Stripe-shaped keys, machine keys, non-empty secret assignments).
    // Test fixtures are intentionally fake (`ak_test_…` literals abound in
    // unit tests), so this scan covers shippable files only — __tests__
    // dirs and *.test.* files are skipped. Fixture detection itself is
    // proved in-memory by the Phase 11 suite (`containsLikelySecret`), and
    // the credential-URL scan above still covers the whole repo.
    const valueShapes = SECRET_SCAN_PATTERNS.slice(1);
    const hits: string[] = [];
    for (const file of repoTextFiles()) {
      if (file.includes("__tests__") || /\.test\.[^.]+$/.test(file)) {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (isPlaceholderLine(line)) {
          continue;
        }
        if (
          valueShapes.some((pattern) => {
            pattern.lastIndex = 0;
            return pattern.test(line);
          })
        ) {
          hits.push(`${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("no payload-cache table in drizzle/", () => {
  test("schema + migrations contain no per-video cache table", () => {
    const drizzleDir = join(REPO_ROOT, "drizzle");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(drizzleDir);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((f) =>
      /transcript/i.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});
