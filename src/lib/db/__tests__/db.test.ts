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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

function mockSql(
  impl: (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => Promise<unknown> = async () => [{ "?column?": 1 }],
): SqlClient {
  const fn = async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<unknown> => impl(strings, ...params);
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
  const skipDirs = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
  ]);
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
      const full = join(dir, entry.name);
      try {
        if (statSync(full).size > 1024 * 1024) {
          continue;
        }
      } catch {
        continue;
      }
      out.push(full);
    }
  };
  walk(REPO_ROOT);
  return out;
}

describe("secret scan", () => {
  test("no credential-shaped database URL literal lives in repo files", () => {
    // Matches scheme + userinfo (user:pass@). Built by concatenation so this
    // file's own pattern source cannot match itself.
    const credentialUrl = new RegExp(
      "postgres(?:ql)?://" + "[^\\s'\"]*:[^\\s'\"]*@",
    );
    const placeholder =
      /<|USER|PASSWORD|HOST|example|YOUR_|changeme|placeholder/i;
    const hits: string[] = [];
    for (const file of repoTextFiles()) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (credentialUrl.test(line) && !placeholder.test(line)) {
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
