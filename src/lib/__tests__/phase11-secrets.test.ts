// Phase 11 (Part B): secret management + secret-leak prevention.
//
// Proves fake secrets injected into headers, bodies, env vars, and thrown
// errors never leak into error responses, telemetry, audit rows, or console
// output; locks the centralized redact helpers; proves the static scan
// patterns detect fixtures; and proves client-reachable source carries no
// server-only secrets.
//
// Fixture hygiene: every fake secret below is assembled by concatenation so
// no secret-shaped literal exists in this file — the repo-wide secret scan
// (db.test.ts + CI) must stay green. The MARKER needle appears in a response,
// log, or trace only when a leak occurs.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import {
  type AuditInput,
  clearAuditEvents,
  getAuditEvents,
  recordAuditEvent,
} from "../audit";
import { clerkErrorResponse } from "../clerk-admin";
import {
  type ObservabilityProvider,
  resetObservabilityProvider,
  type SpanHandle,
  setObservabilityProvider,
} from "../observability";
import { withRequestContext } from "../pipeline";
import {
  containsLikelySecret,
  isPlaceholderLine,
  isSensitiveKey,
  REDACTED,
  redactHeaders,
  redactObject,
  redactUrl,
  SECRET_SCAN_PATTERNS,
  scrubError,
  scrubString,
} from "../redact";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

// Leak needle: a distinctive inert string embedded in every fake secret.
// `expect(...).not.toContain(MARKER)` fails only on an actual leak.
const MARKER = "FakeExampleKey1234567890";

// Fake secrets, assembled by concatenation (never template literals) so no
// secret-shaped literal exists in this file — the repo-wide secret scan
// (db.test.ts + CI) must stay green.
// biome-ignore lint/style/useTemplate: concatenation is the fixture hygiene.
const FAKE_SK = "sk_" + "test_" + MARKER;
// biome-ignore lint/style/useTemplate: concatenation is the fixture hygiene.
const FAKE_AK = "ak_" + "test_" + MARKER;
const FAKE_DB = "postgres" + "ql://fakeuser:Fakepass123@localhost:5432/fakedb";
const FAKE_BEARER = "Bearer " + "FakeExampleBearer1234567890";
// biome-ignore lint/style/useTemplate: concatenation is the fixture hygiene.
const FAKE_SESSION = "sess_" + MARKER;

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: new Headers() });
}

afterEach(() => {
  resetObservabilityProvider();
  clearAuditEvents();
  delete process.env.FAKE_PHASE11_SECRET;
});

describe("isSensitiveKey (Phase 11 inventory)", () => {
  test.each([
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api_key",
    "X-API-KEY",
    "CLERK_SECRET_KEY",
    "TUNNEL_UPDATE_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "SUPADATA_API_KEY",
    "DD_API_KEY",
    "datadog-api-key",
    "client-secret",
    "access-token",
    "access_token",
    "password",
    "passwd",
    "sessionToken",
  ])("flags %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  test.each([
    "x-request-id",
    "content-type",
    "route",
    "requestId",
    "status",
    "name",
    "reason",
    "keyId",
    "subject",
    "tier",
  ])("leaves %s alone", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactHeaders (Phase 11)", () => {
  test("redacts authorization, cookie, and api-key headers", () => {
    const headers = new Headers({
      authorization: `Bearer ${FAKE_AK}`,
      cookie: `tubelens_session=${FAKE_SESSION}`,
      "x-api-key": FAKE_SK,
      "x-request-id": "req-1",
      "content-type": "application/json",
    });
    const redacted = redactHeaders(headers);
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.cookie).toBe(REDACTED);
    expect(redacted["x-api-key"]).toBe(REDACTED);
    expect(redacted["x-request-id"]).toBe("req-1");
    expect(redacted["content-type"]).toBe("application/json");
    expect(JSON.stringify(redacted)).not.toContain(MARKER);
  });

  test("handles plain records, arrays, and empty input", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
    const redacted = redactHeaders({
      authorization: [`Bearer ${FAKE_AK}`, "extra"],
      "x-empty": undefined,
      "x-request-id": "req-2",
    });
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted["x-request-id"]).toBe("req-2");
    expect("x-empty" in redacted).toBe(false);
  });

  test("scrubs secrets pasted into innocuous headers", () => {
    const redacted = redactHeaders({ "x-request-id": `id-${FAKE_SK}` });
    expect(JSON.stringify(redacted)).not.toContain(MARKER);
  });

  test("never mutates the caller's object", () => {
    const input = { authorization: `Bearer ${FAKE_AK}` };
    redactHeaders(input);
    expect(input.authorization).toContain(MARKER);
  });
});

describe("redactObject (Phase 11)", () => {
  test("redacts sensitive keys at any depth, keeps the rest", () => {
    const input = {
      route: "videos",
      auth: { authorization: `Bearer ${FAKE_AK}`, tier: "free" },
      nested: { deep: { database_url: FAKE_DB } },
      list: [FAKE_SK, "plain"],
      count: 3,
      ok: true,
    };
    const redacted = redactObject(input);
    expect(redacted).toMatchObject({
      route: "videos",
      count: 3,
      ok: true,
    });
    expect(JSON.stringify(redacted)).not.toContain(MARKER);
    // Untouched input (no aliasing of the caller's structure).
    expect(JSON.stringify(input)).toContain(MARKER);
  });

  test("collapses circular and over-deep structures instead of throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => redactObject(circular)).not.toThrow();
    const out = redactObject(circular) as Record<string, unknown>;
    expect(out.self).toBe(REDACTED);

    let deep: unknown = { leaf: FAKE_SK };
    for (let i = 0; i < 10; i++) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redactObject(deep))).not.toContain(MARKER);
  });

  test("scrubs Error values embedded in objects", () => {
    const redacted = redactObject({ err: new Error(`boom ${FAKE_AK}`) }) as {
      err: Error;
    };
    expect(redacted.err.message).not.toContain(MARKER);
  });
});

describe("redactUrl (Phase 11)", () => {
  test("strips database userinfo", () => {
    const redacted = redactUrl(FAKE_DB);
    expect(redacted).toBe("postgresql://localhost:5432/fakedb");
    expect(redacted).not.toContain(MARKER);
  });

  test("redacts sensitive query params, keeps the rest", () => {
    const redacted = redactUrl(
      `https://example.com/x?api_key=${MARKER}&q=hello`,
    );
    expect(redacted).toContain("q=hello");
    // URLSearchParams percent-encodes the sentinel; decode before asserting.
    expect(decodeURIComponent(redacted)).toContain(`api_key=${REDACTED}`);
    expect(redacted).not.toContain(MARKER);
  });

  test("redacts secret-bearing hash fragments", () => {
    const redacted = redactUrl(`https://tunnel.example/pair#token=${MARKER}`);
    expect(redacted).not.toContain(MARKER);
    expect(redacted).toContain(`token=${REDACTED}`);
  });

  test("handles relative URLs and opaque strings", () => {
    expect(redactUrl(`/api/v1/x?token=${MARKER}&q=1`)).toBe(
      `/api/v1/x?token=${REDACTED}&q=1`,
    );
    expect(redactUrl("")).toBe("");
    expect(redactUrl(`prefix ${FAKE_SK} suffix`)).toBe(
      `prefix ${REDACTED} suffix`,
    );
  });
});

describe("scrubString / scrubError (Phase 11)", () => {
  test("scrubs every inventoried secret kind in free text", () => {
    const cases = [
      `db ${FAKE_DB} end`,
      `key ${FAKE_SK} end`,
      `machine ${FAKE_AK} end`,
      `auth ${FAKE_BEARER} end`,
      `assign CLERK_SECRET_KEY=${MARKER} end`,
      `tunnel TUNNEL_UPDATE_TOKEN: ${MARKER} end`,
    ];
    for (const text of cases) {
      const scrubbed = scrubString(text);
      expect(scrubbed).not.toContain(MARKER);
    }
  });

  test("leaves benign text intact", () => {
    expect(scrubString("hello world")).toBe("hello world");
    expect(scrubString("postgresql://host:5432/db")).toBe(
      "postgresql://host:5432/db",
    );
    expect(scrubString("DATABASE_URL=")).toBe("DATABASE_URL=");
  });

  test("scrubs error messages, preserves name, drops raw stack content", () => {
    const err = new Error(`kaboom ${FAKE_SK}`);
    err.name = "UpstreamError";
    const clean = scrubError(err) as Error;
    expect(clean).toBeInstanceOf(Error);
    expect(clean.name).toBe("UpstreamError");
    expect(clean.message).not.toContain(MARKER);
    expect(JSON.stringify(clean)).not.toContain(MARKER);
  });

  test("scrubs cause chains without throwing on nesting", () => {
    const inner = new Error(`inner ${FAKE_AK}`);
    const outer = new Error(`outer ${FAKE_SK}`, { cause: inner });
    const clean = scrubError(outer) as Error;
    expect(JSON.stringify(clean)).not.toContain(MARKER);
  });

  test("terminates on Error↔object cycles and redacts both directions", () => {
    const obj: Record<string, unknown> = { label: "cycle" };
    const err = new Error(`boom ${FAKE_AK}`, { cause: obj });
    obj.err = err;
    const fromObj = redactObject(obj) as { err: Error };
    expect(fromObj.err).toBeInstanceOf(Error);
    expect(fromObj.err.message).not.toContain(MARKER);
    // The revisited object collapses instead of recursing.
    expect((fromObj.err as { cause?: unknown }).cause).toBe(REDACTED);
    const fromErr = scrubError(err) as Error;
    expect(JSON.stringify(fromErr)).not.toContain(MARKER);
    expect((fromErr as { cause?: unknown }).cause).toMatchObject({
      label: "cycle",
      err: REDACTED,
    });
  });

  test("passes strings and secret-bearing objects through safely", () => {
    expect(scrubError(`plain ${FAKE_AK}`)).not.toContain(MARKER);
    expect(JSON.stringify(scrubError({ auth: FAKE_AK }))).not.toContain(MARKER);
  });
});

describe("pipeline error + telemetry redaction (Phase 11)", () => {
  interface Captured {
    errors: Array<{ err: unknown; context: unknown }>;
    spanErrors: unknown[];
    logs: unknown[];
  }

  function recordingProvider(captured: Captured): ObservabilityProvider {
    const span: SpanHandle = {
      recordError(err: unknown): void {
        captured.spanErrors.push(err);
      },
      end(): void {},
    };
    return {
      startSpan(): SpanHandle {
        return span;
      },
      log(_level, _message, attrs): void {
        captured.logs.push(attrs);
      },
      increment(): void {},
      captureError(err: unknown, context): void {
        captured.errors.push({ err, context });
      },
    };
  }

  test("thrown secrets never reach the 500 body, captureError, or spans", async () => {
    const captured: Captured = { errors: [], spanErrors: [], logs: [] };
    setObservabilityProvider(recordingProvider(captured));
    // Secrets arrive the way production sees them: pasted into a request
    // body and read from env, then embedded in a thrown error.
    process.env.FAKE_PHASE11_SECRET = FAKE_SK;
    const bodySecret = FAKE_AK;
    const run = withRequestContext(
      async () => {
        throw new Error(
          `upstream said: ${bodySecret} / env said: ${process.env.FAKE_PHASE11_SECRET}`,
          { cause: new Error(`cause ${FAKE_DB}`) },
        );
      },
      {},
      "test-route",
    );
    const res = await run(req("http://x/api/v1/videos/abc"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(MARKER);
    expect(JSON.stringify(captured.errors)).not.toContain(MARKER);
    expect(JSON.stringify(captured.spanErrors)).not.toContain(MARKER);
    expect(JSON.stringify(captured.logs)).not.toContain(MARKER);
    expect(captured.errors.length).toBeGreaterThan(0);
  });
});

describe("audit free-text defense (Phase 11)", () => {
  function baseInput(): AuditInput {
    return {
      action: "user.tier.changed",
      actor: "user_admin1",
      target: "user_target1",
      targetUserId: "user_target1",
      requestId: "req-audit-1",
      oldTier: "free",
      newTier: "pro",
    };
  }

  function captureConsoleInfo(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.info;
    console.info = (message?: unknown) => {
      lines.push(String(message));
    };
    return {
      lines,
      restore: () => {
        console.info = original;
      },
    };
  }

  test("reason carrying a pasted secret is scrubbed in row and log line", () => {
    const spy = captureConsoleInfo();
    try {
      const event = recordAuditEvent({
        ...baseInput(),
        reason: `rotation ${FAKE_SK} done`,
      });
      expect(JSON.stringify(event)).not.toContain(MARKER);
      expect(JSON.stringify(getAuditEvents())).not.toContain(MARKER);
      expect(JSON.stringify(spy.lines)).not.toContain(MARKER);
    } finally {
      spy.restore();
    }
  });

  test("revocation reason and key name are scrubbed", () => {
    const spy = captureConsoleInfo();
    try {
      const event = recordAuditEvent({
        action: "api_key.revoked",
        actor: "user_admin1",
        target: "user_target1",
        targetUserId: "user_target1",
        requestId: "req-audit-2",
        keyId: "key_123",
        revocationReason: `leaked ${FAKE_AK}`,
      });
      expect(JSON.stringify(event)).not.toContain(MARKER);
      expect(JSON.stringify(spy.lines)).not.toContain(MARKER);

      const issued = recordAuditEvent({
        action: "api_key.issued",
        actor: "user_admin1",
        target: "user_target1",
        targetUserId: "user_target1",
        requestId: "req-audit-3",
        keyId: "key_124",
        name: `cron ${FAKE_SK}`,
        scopes: [],
        tierAtIssuance: "free",
      });
      expect(JSON.stringify(issued)).not.toContain(MARKER);
    } finally {
      spy.restore();
    }
  });

  test("over-long reasons truncate to the schema bound", () => {
    const spy = captureConsoleInfo();
    try {
      const event = recordAuditEvent({
        ...baseInput(),
        reason: `r${"eason ".repeat(60)}`,
      });
      if (event.action === "user.tier.changed") {
        expect(event.reason?.length).toBeLessThanOrEqual(280);
      } else {
        throw new Error("unexpected audit action shape");
      }
    } finally {
      spy.restore();
    }
  });

  test("unknown keys smuggling secrets are stripped at runtime", () => {
    const spy = captureConsoleInfo();
    try {
      const smuggled = {
        ...baseInput(),
        reason: "routine",
        injectedSecret: FAKE_AK,
      } as unknown as AuditInput;
      const event = recordAuditEvent(smuggled);
      expect("injectedSecret" in event).toBe(false);
      expect(JSON.stringify(event)).not.toContain(MARKER);
      expect(JSON.stringify(spy.lines)).not.toContain(MARKER);
    } finally {
      spy.restore();
    }
  });
});

describe("clerkErrorResponse never serializes backend errors (Phase 11)", () => {
  test.each([
    ["timeout", () => new DOMException(`timed out ${FAKE_SK}`, "TimeoutError")],
    [
      "404",
      () => Object.assign(new Error(`missing ${FAKE_AK}`), { status: 404 }),
    ],
    [
      "429",
      () =>
        Object.assign(new Error(`limited ${FAKE_SK}`), {
          status: 429,
          retryAfter: 30,
        }),
    ],
    [
      "401",
      () => Object.assign(new Error(`denied ${FAKE_AK}`), { status: 401 }),
    ],
    [
      "422",
      () => Object.assign(new Error(`rejected ${FAKE_SK}`), { status: 422 }),
    ],
    ["generic", () => new Error(`broke ${FAKE_DB}`)],
  ])("%s branch leaks nothing", async (_label, makeErr) => {
    const res = clerkErrorResponse("req-clerk-1", makeErr());
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("Fakepass");
  });
});

describe("static scan pattern coverage (Phase 11)", () => {
  test("every inventoried value shape is detected", () => {
    const fixtures = [
      FAKE_DB,
      FAKE_SK,
      FAKE_AK,
      `CLERK_SECRET_KEY=${MARKER}`,
      `tunnel TUNNEL_UPDATE_TOKEN: ${MARKER}`,
      `db DATABASE_URL=${MARKER}`,
      `blob BLOB_READ_WRITE_TOKEN=${MARKER}`,
      `audio TUBELENS_AUDIO_SECRET=${MARKER}`,
      `transcript SUPADATA_API_KEY=${MARKER}`,
      `metrics DATADOG_API_KEY=${MARKER}`,
    ];
    expect(SECRET_SCAN_PATTERNS.length).toBeGreaterThanOrEqual(4);
    for (const fixture of fixtures) {
      expect(containsLikelySecret(fixture)).toBe(true);
    }
  });

  test("benign text is not flagged", () => {
    for (const clean of [
      "hello world",
      "postgresql://host:5432/db",
      "DATABASE_URL=",
      "use process.env.DATABASE_URL at runtime",
      "startsWith prefix checks and ak_* prose",
      "Bearer ok",
    ]) {
      expect(containsLikelySecret(clean)).toBe(false);
    }
  });

  test("placeholder lines are recognized as documentation noise", () => {
    expect(isPlaceholderLine("DATABASE_URL=<user>:<pass>@host")).toBe(true);
    expect(isPlaceholderLine("set YOUR_API_KEY here")).toBe(true);
    expect(isPlaceholderLine("uses process.env.FOO in tests")).toBe(true);
    expect(isPlaceholderLine("sk_live_RealKeyAbc123Xyz789")).toBe(false);
  });
});

describe("client-reachable source hygiene (Phase 11)", () => {
  const SERVER_SECRET_NAMES = [
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "CLERK_SECRET_KEY",
    "TUNNEL_UPDATE_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
    "TUBELENS_AUDIO_SECRET",
    "SUPADATA_API_KEY",
    "DATADOG_API_KEY",
    "DD_API_KEY",
  ];

  function walk(dir: string, suffixes: string[]): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full, suffixes));
      } else if (suffixes.some((s) => entry.name.endsWith(s))) {
        out.push(full);
      }
    }
    return out;
  }

  test("dev pages stay server-side with value-free secret reads", () => {
    const devDir = join(REPO_ROOT, "src", "app", "dev");
    const files = walk(devDir, [".tsx", ".ts"]);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/["']use client["']/);
      expect(containsLikelySecret(text)).toBe(false);
      expect(text).not.toContain("NEXT_PUBLIC_");
    }
    const page = readFileSync(join(devDir, "t3", "page.tsx"), "utf8");
    expect(page).toContain("process.env.BLOB_READ_WRITE_TOKEN");
  });

  test("no client component references server-only secret names", () => {
    const offenders: string[] = [];
    for (const file of walk(join(REPO_ROOT, "src"), [".tsx", ".ts"])) {
      const text = readFileSync(file, "utf8");
      if (!/["']use client["']/.test(text)) {
        continue;
      }
      if (SERVER_SECRET_NAMES.some((name) => text.includes(name))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
