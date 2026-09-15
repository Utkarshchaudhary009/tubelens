import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  handleAdminKeysRevoke,
  POST as revokePOST,
} from "../../app/api/v1/admin/keys/[keyId]/revoke/route";
import {
  handleAdminKeysCreate,
  handleAdminKeysList,
  GET as keysGET,
  POST as keysPOST,
} from "../../app/api/v1/admin/keys/route";
import { handleMe } from "../../app/api/v1/me/route";
import {
  type ApiKeyRecord,
  type ApiKeysClient,
  clearApiKeyMetadata,
  createKeyBodySchema,
  getKeyMetadata,
  hasPrivilegeClaims,
  mapApiKeyBodyError,
  resetApiKeysClient,
  revokeKeyBodySchema,
  setApiKeysClient,
  tierRank,
} from "../api-keys";
import { clearAuditEvents, getAuditEvents } from "../audit";
import { type AuthContext, requireAdmin, requireAuth } from "../auth";
import {
  clerkAuthProvider,
  extractBearerSecret,
  resolveApiKeyContext,
} from "../clerk-auth";

// Env + seam hygiene: tests inject a mocked key backend and touch the audit
// + metadata stores — always reset so later files see a clean keyless env.
const savedEnforcement = process.env.TUBELENS_AUTH_ENFORCEMENT;
const savedSecret = process.env.CLERK_SECRET_KEY;
const savedPublishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

afterEach(() => {
  resetApiKeysClient();
  clearApiKeyMetadata();
  clearAuditEvents();
  if (savedEnforcement === undefined) {
    delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  } else {
    process.env.TUBELENS_AUTH_ENFORCEMENT = savedEnforcement;
  }
  if (savedSecret === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = savedSecret;
  }
  if (savedPublishable === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = savedPublishable;
  }
});

function keylessEnv(): void {
  delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

const adminAuth: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_admin1",
  tier: "pro",
  role: "admin",
};

const userAuth: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_bob1",
  tier: "free",
  role: "user",
};

const anonAuth: AuthContext = { type: "anonymous", authenticated: false };

const apiKeyAuth: AuthContext = {
  type: "api_key",
  authenticated: true,
  userId: "user_admin1",
  tier: "pro",
  keyId: "key_1",
};

type MockMeta = { tier?: unknown; role?: unknown };

interface MockKeyState {
  id: string;
  secret: string;
  name: string;
  subject: string;
  scopes: string[];
  claims: Record<string, unknown> | null;
  revoked: boolean;
  revocationReason: string | null;
  expired: boolean;
  expiration: number | null;
  createdBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Mocked Clerk key backend: authoritative metadata lives in `users`, key
 * state in `keys` (keyed by id, with a secret index). `verifyKey` throws on
 * missing/revoked/expired exactly like the live authority. Every call's
 * fail-fast signal is recorded for assertions.
 */
function mockApiKeys(
  users: Record<string, MockMeta>,
  opts: {
    failGet?: unknown;
    failCreate?: unknown;
    failList?: unknown;
    failRevoke?: unknown;
    failVerify?: unknown;
    seedKeys?: MockKeyState[];
  } = {},
): {
  client: ApiKeysClient;
  seen: { op: string; signal: unknown; params?: unknown }[];
  keys: Map<string, MockKeyState>;
} {
  const seen: { op: string; signal: unknown; params?: unknown }[] = [];
  const keys = new Map<string, MockKeyState>();
  for (const key of opts.seedKeys ?? []) {
    keys.set(key.id, key);
  }
  let counter = keys.size;
  const toRecord = (
    state: MockKeyState,
    withSecret: boolean,
  ): ApiKeyRecord => ({
    id: state.id,
    name: state.name,
    subject: state.subject,
    scopes: [...state.scopes],
    claims: state.claims ? { ...state.claims } : null,
    revoked: state.revoked,
    revocationReason: state.revocationReason,
    expired: state.expired,
    expiration: state.expiration,
    createdBy: state.createdBy,
    createdAt: state.createdAt,
    lastUsedAt: state.lastUsedAt,
    ...(withSecret ? { secret: state.secret } : {}),
  });
  const client: ApiKeysClient = {
    async getUser(userId, o) {
      seen.push({ op: "getUser", signal: o?.signal });
      if (opts.failGet !== undefined) {
        throw opts.failGet;
      }
      const meta = users[userId];
      if (!meta) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return { id: userId, publicMetadata: { ...meta } };
    },
    async createKey(params, o) {
      seen.push({
        op: "createKey",
        signal: o?.signal,
        params: { ...params },
      });
      if (opts.failCreate !== undefined) {
        throw opts.failCreate;
      }
      counter += 1;
      const state: MockKeyState = {
        id: `key_${counter}`,
        secret: `ak_test_secret_${counter}`,
        name: params.name,
        subject: params.subject,
        scopes: [...(params.scopes ?? [])],
        claims: params.claims ? { ...params.claims } : null,
        revoked: false,
        revocationReason: null,
        expired: false,
        expiration:
          params.secondsUntilExpiration != null
            ? Date.now() + params.secondsUntilExpiration * 1000
            : null,
        createdBy: params.createdBy ?? null,
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      keys.set(state.id, state);
      // The secret travels ONLY on this creation record — never again.
      return toRecord(state, true);
    },
    async listKeys(params, o) {
      seen.push({ op: "listKeys", signal: o?.signal, params: { ...params } });
      if (opts.failList !== undefined) {
        throw opts.failList;
      }
      return [...keys.values()]
        .filter((key) => key.subject === params.subject)
        .filter((key) => (params.includeInvalid ? true : !key.revoked))
        .map((key) => toRecord(key, false));
    },
    async revokeKey(params, o) {
      seen.push({
        op: "revokeKey",
        signal: o?.signal,
        params: { ...params },
      });
      if (opts.failRevoke !== undefined) {
        throw opts.failRevoke;
      }
      const state = keys.get(params.apiKeyId);
      if (!state) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      state.revoked = true;
      if (params.revocationReason != null) {
        state.revocationReason = params.revocationReason;
      }
      return toRecord(state, false);
    },
    async verifyKey(secret, o) {
      seen.push({ op: "verifyKey", signal: o?.signal });
      if (opts.failVerify !== undefined) {
        throw opts.failVerify;
      }
      const state = [...keys.values()].find((key) => key.secret === secret);
      if (!state || state.revoked || state.expired) {
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      }
      return toRecord(state, false);
    },
  };
  return { client, seen, keys };
}

function bearerReq(secret: string | null): Request {
  const headers = new Headers();
  if (secret !== null) {
    headers.set("authorization", `Bearer ${secret}`);
  }
  return new Request("http://x/api/v1/search?q=cats", { headers });
}

describe("key body schemas (Phase 05)", () => {
  test("create schema accepts minimal and full bodies", () => {
    expect(
      createKeyBodySchema.safeParse({ subject: "user_a1", name: "cron" })
        .success,
    ).toBe(true);
    expect(
      createKeyBodySchema.safeParse({
        subject: "user_a1",
        name: "cron",
        scopes: ["search:read", "videos:read"],
        secondsUntilExpiration: 3600,
        claims: { env: "prod" },
      }).success,
    ).toBe(true);
  });

  test("create schema rejects bad subjects", () => {
    for (const subject of ["", "bob", "user_", "user_a b", "usr_1", 42, null]) {
      expect(
        createKeyBodySchema.safeParse({ subject, name: "cron" }).success,
      ).toBe(false);
    }
  });

  test("create schema rejects bad names", () => {
    for (const name of ["", "   ", "x".repeat(65), 42, null]) {
      expect(
        createKeyBodySchema.safeParse({ subject: "user_a1", name }).success,
      ).toBe(false);
    }
  });

  test("create schema rejects unknown scopes", () => {
    // Uppercase, over-long, non-string, and over-limit entries all fail the
    // validated-string-array passthrough (no cost catalog is invented).
    const badScopes: unknown[][] = [
      ["READ:all"],
      ["search:read", "Videos:Read"],
      ["x".repeat(65)],
      [""],
      ["ok", 42],
      Array.from({ length: 21 }, (_, i) => `scope:${i}`),
    ];
    for (const scopes of badScopes) {
      expect(
        createKeyBodySchema.safeParse({ subject: "user_a1", name: "k", scopes })
          .success,
      ).toBe(false);
    }
    expect(
      createKeyBodySchema.safeParse({
        subject: "user_a1",
        name: "k",
        scopes: ["a:b_c-d:e9"],
      }).success,
    ).toBe(true);
  });

  test("create schema rejects bad expiry", () => {
    for (const secondsUntilExpiration of [
      0,
      -5,
      30,
      1.5,
      Number.NaN,
      "never",
      99_999_999_999,
      null,
    ]) {
      expect(
        createKeyBodySchema.safeParse({
          subject: "user_a1",
          name: "k",
          secondsUntilExpiration,
        }).success,
      ).toBe(false);
    }
    expect(
      createKeyBodySchema.safeParse({
        subject: "user_a1",
        name: "k",
        secondsUntilExpiration: 60,
      }).success,
    ).toBe(true);
  });

  test("strict schemas deny smuggled privilege keys", () => {
    expect(
      createKeyBodySchema.safeParse({
        subject: "user_a1",
        name: "k",
        tier: "enterprise",
      }).success,
    ).toBe(false);
    expect(
      createKeyBodySchema.safeParse({
        subject: "user_a1",
        name: "k",
        role: "admin",
      }).success,
    ).toBe(false);
    expect(
      revokeKeyBodySchema.safeParse({ revocationReason: "x", admin: true })
        .success,
    ).toBe(false);
  });

  test("revoke schema accepts empty/valid bodies, rejects long reasons", () => {
    expect(revokeKeyBodySchema.safeParse({}).success).toBe(true);
    expect(
      revokeKeyBodySchema.safeParse({ revocationReason: "rotated" }).success,
    ).toBe(true);
    expect(
      revokeKeyBodySchema.safeParse({ revocationReason: "x".repeat(281) })
        .success,
    ).toBe(false);
  });

  test("mapApiKeyBodyError maps typed 400 codes", () => {
    expect(mapApiKeyBodyError([{ path: ["subject"], code: "x" }]).code).toBe(
      "invalid_subject",
    );
    expect(mapApiKeyBodyError([{ path: ["scopes", 0], code: "x" }]).code).toBe(
      "invalid_scope",
    );
    expect(
      mapApiKeyBodyError([{ path: ["secondsUntilExpiration"], code: "x" }])
        .code,
    ).toBe("invalid_expiry");
    expect(mapApiKeyBodyError([{ path: ["claims"], code: "x" }]).code).toBe(
      "invalid_claims",
    );
    expect(mapApiKeyBodyError([{ path: ["name"], code: "x" }]).code).toBe(
      "invalid_name",
    );
    expect(
      mapApiKeyBodyError([{ path: ["revocationReason"], code: "x" }]).code,
    ).toBe("invalid_reason");
    expect(mapApiKeyBodyError([{ path: [], code: "x" }]).code).toBe(
      "invalid_body",
    );
  });

  test("hasPrivilegeClaims + tierRank", () => {
    expect(hasPrivilegeClaims({ env: "prod" })).toBe(false);
    expect(hasPrivilegeClaims({ tier: "free" })).toBe(true);
    expect(hasPrivilegeClaims({ role: "user" })).toBe(true);
    expect(tierRank("free")).toBeLessThan(tierRank("plus"));
    expect(tierRank("plus")).toBeLessThan(tierRank("pro"));
    expect(tierRank("pro")).toBeLessThan(tierRank("enterprise"));
  });
});

describe("POST /admin/keys happy path (Phase 05)", () => {
  test("200 issues a key, binds authoritative tier, returns the secret once", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client, seen } = mockApiKeys(users);
    const res = await handleAdminKeysCreate(
      "keys-happy-1",
      adminAuth,
      {
        subject: "user_pro1",
        name: "nightly cron",
        scopes: ["search:read"],
        secondsUntilExpiration: 3600,
      },
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("keys-happy-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("keys-happy-1");
    // The secret appears exactly once, in this creation response.
    expect(typeof body.data.secret).toBe("string");
    expect(body.data.secret.startsWith("ak_test_")).toBe(true);
    expect(body.data).toMatchObject({
      subject: "user_pro1",
      name: "nightly cron",
      scopes: ["search:read"],
      tierAtIssuance: "pro",
      createdBy: "user_admin1",
    });
    expect(typeof body.data.expiresAt).toBe("string");
    // Fresh 8s budget per call: caller check, subject read, then create.
    expect(seen.map((s) => s.op)).toEqual(["getUser", "getUser", "createKey"]);
    for (const s of seen) {
      expect(s.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(seen.map((s) => s.signal)).size).toBe(3);
    // The create call never carries a client-supplied tier.
    const createParams = seen.find((s) => s.op === "createKey")
      ?.params as Record<string, unknown>;
    expect("tier" in createParams).toBe(false);
    expect(createParams).toMatchObject({
      name: "nightly cron",
      subject: "user_pro1",
      createdBy: "user_admin1",
    });
    // One sanitized audit row, secret-free.
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "api_key.issued",
      actor: "user_admin1",
      target: "user_pro1",
      targetUserId: "user_pro1",
      keyId: body.data.keyId,
      name: "nightly cron",
      scopes: ["search:read"],
      tierAtIssuance: "pro",
      requestId: "keys-happy-1",
    });
    expect(JSON.stringify(rows[0])).not.toContain(body.data.secret);
    // The in-memory overlay holds metadata only — never the secret.
    const overlay = getKeyMetadata(body.data.keyId);
    expect(overlay).toMatchObject({
      keyId: body.data.keyId,
      subject: "user_pro1",
      tierAtIssuance: "pro",
      createdBy: "user_admin1",
      revoked: false,
    });
    expect(JSON.stringify(overlay)).not.toContain(body.data.secret);
  });

  test("tierAtIssuance comes from authoritative metadata, not stale claims", async () => {
    // Caller session still projects free while authoritative metadata is pro;
    // the subject is enterprise. Both reads use getUser state.
    const staleAdmin: AuthContext = { ...adminAuth, tier: "free" };
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "enterprise", role: "admin" },
      user_ent1: { tier: "enterprise", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const res = await handleAdminKeysCreate(
      "keys-stale-1",
      staleAdmin,
      { subject: "user_ent1", name: "etl" },
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tierAtIssuance).toBe("enterprise");
    expect(getAuditEvents()[0]).toMatchObject({ tierAtIssuance: "enterprise" });
  });

  test("missing authoritative tier normalizes to free, never escalates", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_weird1: { tier: "team", role: "owner" },
    };
    const { client } = mockApiKeys(users);
    const res = await handleAdminKeysCreate(
      "keys-weird-1",
      adminAuth,
      { subject: "user_weird1", name: "etl" },
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.tierAtIssuance).toBe("free");
  });

  test("create reason is audited; over-long reason is 400 invalid_reason", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const res = await handleAdminKeysCreate(
      "keys-reason-1",
      adminAuth,
      { subject: "user_pro1", name: "etl", reason: "rotation prep" },
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect(getAuditEvents()[0]).toMatchObject({
      action: "api_key.issued",
      reason: "rotation prep",
    });

    const longRes = await handleAdminKeysCreate(
      "keys-reason-2",
      adminAuth,
      { subject: "user_pro1", name: "etl", reason: "x".repeat(281) },
      { apiKeys: client },
    );
    expect(longRes.status).toBe(400);
    expect((await longRes.json()).error.code).toBe("invalid_reason");
    expect(getAuditEvents()).toHaveLength(1);
  });
});

describe("POST /admin/keys guards (Phase 05)", () => {
  test("401 unauthenticated for anonymous AND api-key principals", async () => {
    const { client, seen } = mockApiKeys({});
    for (const [label, ctx] of [
      ["anon", anonAuth],
      ["api-key", apiKeyAuth],
    ] as const) {
      const res = await handleAdminKeysCreate(
        `keys-401-${label}`,
        ctx,
        { subject: "user_a1", name: "k" },
        { apiKeys: client },
      );
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthenticated");
    }
    // API-key principals can NEVER pass requireAdmin — denied before any
    // backend call or audit row.
    expect(requireAdmin(apiKeyAuth)).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect(seen).toHaveLength(0);
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("403 non-admin and demoted caller", async () => {
    const users: Record<string, MockMeta> = {
      user_bob1: { tier: "free", role: "user" },
      user_admin1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const nonAdmin = await handleAdminKeysCreate(
      "keys-403-user",
      userAuth,
      { subject: "user_bob1", name: "k" },
      { apiKeys: client },
    );
    expect(nonAdmin.status).toBe(403);
    expect((await nonAdmin.json()).error.code).toBe("forbidden");
    // Session claims admin but authoritative metadata demoted → fail closed.
    const demoted = await handleAdminKeysCreate(
      "keys-403-demoted",
      adminAuth,
      { subject: "user_bob1", name: "k" },
      { apiKeys: client },
    );
    expect(demoted.status).toBe(403);
    expect((await demoted.json()).error.message).toMatch(/no longer valid/i);
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("403 on privilege claims and on self-grant above caller tier", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "plus", role: "admin" },
      user_ent9: { tier: "enterprise", role: "user" },
      user_plus9: { tier: "plus", role: "user" },
    };
    const { client, keys } = mockApiKeys(users);
    for (const claims of [{ tier: "plus" }, { role: "user" }]) {
      const res = await handleAdminKeysCreate(
        "keys-403-claims",
        adminAuth,
        { subject: "user_plus9", name: "k", claims },
        { apiKeys: client },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden");
    }
    // Caller is plus; subject is enterprise → minting above own tier denied.
    const selfGrant = await handleAdminKeysCreate(
      "keys-403-selfgrant",
      { ...adminAuth, tier: "plus" },
      { subject: "user_ent9", name: "k" },
      { apiKeys: client },
    );
    expect(selfGrant.status).toBe(403);
    expect((await selfGrant.json()).error.message).toMatch(/own tier/i);
    // Same-tier issuance is allowed.
    const sameTier = await handleAdminKeysCreate(
      "keys-200-sametier",
      { ...adminAuth, tier: "plus" },
      { subject: "user_plus9", name: "k" },
      { apiKeys: client },
    );
    expect(sameTier.status).toBe(200);
    expect(keys.size).toBe(1);
    expect(getAuditEvents()).toHaveLength(1);
  });

  test("400 invalid_subject / invalid_scope / invalid_expiry / smuggled body", async () => {
    const { client } = mockApiKeys({
      user_admin1: { tier: "pro", role: "admin" },
    });
    const cases: { body: unknown; code: string }[] = [
      { body: { subject: "bob", name: "k" }, code: "invalid_subject" },
      {
        body: { subject: "user_a1", name: "k", scopes: ["READ:all"] },
        code: "invalid_scope",
      },
      {
        body: { subject: "user_a1", name: "k", secondsUntilExpiration: 0 },
        code: "invalid_expiry",
      },
      {
        body: { subject: "user_a1", name: "k", tier: "enterprise" },
        code: "invalid_body",
      },
    ];
    for (const { body, code } of cases) {
      const res = await handleAdminKeysCreate(
        `keys-400-${code}`,
        adminAuth,
        body,
        {
          apiKeys: client,
        },
      );
      expect(res.status).toBe(400);
      const parsed = await res.json();
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.hint).toBeString();
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("503 key_authority_error when the authority returns no secret", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    // Authority created the key but broke the once-secret contract: the
    // issuance must not be presented as success, audited, or overlaid.
    const secretless: ApiKeysClient = {
      ...client,
      async createKey(params, o) {
        const created = await client.createKey(params, o);
        const { secret: _dropped, ...rest } = created;
        return rest;
      },
    };
    const res = await handleAdminKeysCreate(
      "keys-nosecret-1",
      adminAuth,
      { subject: "user_pro1", name: "k" },
      { apiKeys: secretless },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("key_authority_error");
    expect(body.error.hint).toBeString();
    expect(getAuditEvents()).toHaveLength(0);
    expect(getKeyMetadata("key_1")).toBeUndefined();
  });

  test("404 unknown subject maps to user_not_found with no audit row", async () => {
    const { client } = mockApiKeys({
      user_admin1: { tier: "pro", role: "admin" },
    });
    const res = await handleAdminKeysCreate(
      "keys-404-1",
      adminAuth,
      { subject: "user_ghost1", name: "k" },
      { apiKeys: client },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("user_not_found");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("fail-fast timeout maps to 504 upstream_timeout with no audit row", async () => {
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const { client } = mockApiKeys({}, { failGet: timeout });
    const res = await handleAdminKeysCreate(
      "keys-timeout-1",
      adminAuth,
      { subject: "user_a1", name: "k" },
      { apiKeys: client },
    );
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
    expect(getAuditEvents()).toHaveLength(0);
  });
});

describe("GET /admin/keys (Phase 05)", () => {
  test("200 lists metadata without secrets, overlays tierAtIssuance", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const created = await handleAdminKeysCreate(
      "keys-list-issue",
      adminAuth,
      { subject: "user_pro1", name: "cron", scopes: ["search:read"] },
      { apiKeys: client },
    );
    const secret = (await created.json()).data.secret as string;
    clearAuditEvents();

    const res = await handleAdminKeysList(
      "keys-list-1",
      adminAuth,
      "user_pro1",
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("keys-list-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      subject: "user_pro1",
      name: "cron",
      scopes: ["search:read"],
      revoked: false,
      tierAtIssuance: "pro",
    });
    expect("secret" in body.data[0]).toBe(false);
    // The secret appears nowhere outside the creation response.
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(getAuditEvents())).not.toContain(secret);
  });

  test("empty subject returns data: [] with next: null (never 404)", async () => {
    const { client } = mockApiKeys({
      user_admin1: { tier: "pro", role: "admin" },
    });
    const res = await handleAdminKeysList(
      "keys-list-empty",
      adminAuth,
      "user_nokeys1",
      {
        apiKeys: client,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("400 invalid_subject when missing or malformed", async () => {
    const { client } = mockApiKeys({});
    for (const subject of [null, "", "bob", "user_", "usr_1"]) {
      const res = await handleAdminKeysList(
        "keys-list-400",
        adminAuth,
        subject,
        { apiKeys: client },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_subject");
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("401 anonymous/api-key and 403 non-admin", async () => {
    const { client, seen } = mockApiKeys({});
    for (const [label, ctx, status] of [
      ["anon", anonAuth, 401],
      ["api-key", apiKeyAuth, 401],
      ["user", userAuth, 403],
    ] as const) {
      const res = await handleAdminKeysList(
        `keys-list-${label}`,
        ctx,
        "user_a1",
        {
          apiKeys: client,
        },
      );
      expect(res.status).toBe(status);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("POST /admin/keys/:keyId/revoke (Phase 05)", () => {
  test("200 revokes, audits, and marks the overlay — empty body works", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const created = await handleAdminKeysCreate(
      "keys-revoke-issue",
      adminAuth,
      { subject: "user_pro1", name: "cron" },
      { apiKeys: client },
    );
    const keyId = (await created.json()).data.keyId as string;
    clearAuditEvents();

    const res = await handleAdminKeysRevoke(
      "keys-revoke-1",
      adminAuth,
      keyId,
      {},
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("keys-revoke-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({ keyId, revoked: true });
    expect(getKeyMetadata(keyId)).toMatchObject({ revoked: true });
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "api_key.revoked",
      actor: "user_admin1",
      target: "user_pro1",
      targetUserId: "user_pro1",
      keyId,
      requestId: "keys-revoke-1",
    });
    expect("reason" in rows[0]).toBe(false);
  });

  test("revocationReason echoes through response, overlay, and audit", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    const created = await handleAdminKeysCreate(
      "keys-revoke-issue-2",
      adminAuth,
      { subject: "user_pro1", name: "cron" },
      { apiKeys: client },
    );
    const keyId = (await created.json()).data.keyId as string;
    clearAuditEvents();

    const res = await handleAdminKeysRevoke(
      "keys-revoke-2",
      adminAuth,
      keyId,
      { revocationReason: "rotated" },
      { apiKeys: client },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      keyId,
      revoked: true,
      revocationReason: "rotated",
    });
    expect(getKeyMetadata(keyId)).toMatchObject({
      revoked: true,
      revocationReason: "rotated",
    });
    expect(getAuditEvents()[0]).toMatchObject({
      action: "api_key.revoked",
      revocationReason: "rotated",
      reason: "rotated",
    });
  });

  test("400 invalid_key_id, 404 key_not_found (never user_not_found)", async () => {
    const { client } = mockApiKeys({
      user_admin1: { tier: "pro", role: "admin" },
    });
    for (const keyId of ["", "key with spaces", "key/1"]) {
      const res = await handleAdminKeysRevoke(
        "keys-revoke-400",
        adminAuth,
        keyId,
        {},
        {
          apiKeys: client,
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_key_id");
    }
    const missing = await handleAdminKeysRevoke(
      "keys-revoke-404",
      adminAuth,
      "key_nope1",
      {},
      { apiKeys: client },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("key_not_found");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("401 anonymous/api-key and 403 non-admin", async () => {
    const { client, seen } = mockApiKeys({});
    for (const [label, ctx, status] of [
      ["anon", anonAuth, 401],
      ["api-key", apiKeyAuth, 401],
      ["user", userAuth, 403],
    ] as const) {
      const res = await handleAdminKeysRevoke(
        `keys-revoke-${label}`,
        ctx,
        "key_1",
        {},
        { apiKeys: client },
      );
      expect(res.status).toBe(status);
    }
    expect(seen).toHaveLength(0);
    expect(getAuditEvents()).toHaveLength(0);
  });
});

describe("machine verification (Phase 05)", () => {
  test("extractBearerSecret accepts ak_* bearers only", () => {
    const withHeader = (value: string | null) =>
      extractBearerSecret({
        headers: {
          get: () => value,
        },
      });
    expect(withHeader("Bearer ak_test_123")).toBe("ak_test_123");
    expect(withHeader("bearer ak_live_abc")).toBe("ak_live_abc");
    expect(withHeader("Bearer  ak_test_padded  ")).toBe("ak_test_padded");
    for (const header of [
      null,
      "",
      "Bearer",
      "Bearer ",
      "Basic ak_test_123",
      "Bearer eyJhbGciOiJSUzI1NiJ9.session",
      "Bearer sk_live_notakey",
      "Token ak_test_123",
    ]) {
      expect(withHeader(header)).toBeUndefined();
    }
  });

  test("resolveApiKeyContext verifies ak_* and binds the authoritative tier", async () => {
    const users: Record<string, MockMeta> = {
      user_pro1: { tier: "pro", role: "user" },
    };
    const seed: MockKeyState = {
      id: "key_7",
      secret: "ak_test_valid_7",
      name: "cron",
      subject: "user_pro1",
      scopes: ["search:read"],
      claims: null,
      revoked: false,
      revocationReason: null,
      expired: false,
      expiration: null,
      createdBy: "user_admin1",
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const { client, seen } = mockApiKeys(users, { seedKeys: [seed] });
    const ctx = await resolveApiKeyContext("ak_test_valid_7", client);
    expect(ctx).toMatchObject({
      type: "api_key",
      authenticated: true,
      userId: "user_pro1",
      tier: "pro",
      keyId: "key_7",
    });
    // Fail-fast signals travelled with verify + subject read.
    expect(seen.map((s) => s.op)).toEqual(["verifyKey", "getUser"]);
    for (const s of seen) {
      expect(s.signal).toBeInstanceOf(AbortSignal);
    }
    // Api-key principals can never read /me (defense in depth).
    expect(handleMe("me-apikey-1", ctx, ctx.tier ?? "free").status).toBe(401);
  });

  test("resolveApiKeyContext degrades to anonymous on bad secrets", async () => {
    const revoked: MockKeyState = {
      id: "key_8",
      secret: "ak_test_revoked_8",
      name: "old",
      subject: "user_pro1",
      scopes: [],
      claims: null,
      revoked: true,
      revocationReason: "rotated",
      expired: false,
      expiration: null,
      createdBy: "user_admin1",
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const expired: MockKeyState = {
      ...revoked,
      id: "key_9",
      secret: "ak_test_expired_9",
      revoked: false,
      expired: true,
    };
    const { client, seen } = mockApiKeys(
      { user_pro1: { tier: "pro", role: "user" } },
      { seedKeys: [revoked, expired] },
    );
    for (const secret of [
      "ak_test_missing",
      "ak_test_revoked_8",
      "ak_test_expired_9",
    ]) {
      const ctx = await resolveApiKeyContext(secret, client);
      expect(ctx).toEqual({ type: "anonymous", authenticated: false });
      // Denied downstream: protected routes 401.
      expect(requireAuth({ auth: ctx, requestId: "r" })?.status).toBe(401);
    }
    // No bearer → anonymous WITHOUT a backend call.
    const before = seen.length;
    expect(await resolveApiKeyContext(undefined, client)).toEqual({
      type: "anonymous",
      authenticated: false,
    });
    expect(seen.length).toBe(before);
  });

  test("verified-but-flagged keys deny even when verify resolves", async () => {
    // Fail-closed guard: a verify result already carrying revoked/expired
    // must resolve anonymous — never trust the payload, even though the
    // authority resolved instead of threw.
    const flagged: MockKeyState = {
      id: "key_11",
      secret: "ak_test_flagged_11",
      name: "stale",
      subject: "user_pro1",
      scopes: [],
      claims: null,
      revoked: true,
      revocationReason: "rotated",
      expired: false,
      expiration: null,
      createdBy: "user_admin1",
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const { client, seen } = mockApiKeys(
      { user_pro1: { tier: "pro", role: "user" } },
      { seedKeys: [flagged] },
    );
    // Bypass the mock's throwing verify: resolve the revoked record itself.
    const passthrough: ApiKeysClient = {
      ...client,
      async verifyKey(secret, o) {
        seen.push({ op: "verifyKey", signal: o?.signal });
        const state = [...[flagged]].find((key) => key.secret === secret);
        if (!state) {
          throw Object.assign(new Error("invalid api key"), { status: 401 });
        }
        return {
          id: state.id,
          name: state.name,
          subject: state.subject,
          scopes: [...state.scopes],
          claims: null,
          revoked: state.revoked,
          revocationReason: state.revocationReason,
          expired: state.expired,
          expiration: state.expiration,
          createdBy: state.createdBy,
          createdAt: state.createdAt,
          lastUsedAt: state.lastUsedAt,
        };
      },
    };
    const ctx = await resolveApiKeyContext("ak_test_flagged_11", passthrough);
    expect(ctx).toEqual({ type: "anonymous", authenticated: false });
    expect(requireAuth({ auth: ctx, requestId: "r" })?.status).toBe(401);
  });

  test("deleted subject (getUser 404) denies; transient errors fall back to free", async () => {
    const seed: MockKeyState = {
      id: "key_10",
      secret: "ak_test_valid_10",
      name: "cron",
      subject: "user_gone1",
      scopes: [],
      claims: null,
      revoked: false,
      revocationReason: null,
      expired: false,
      expiration: null,
      createdBy: "user_admin1",
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    // Seed users WITHOUT the subject: verify succeeds, getUser 404s →
    // the key no longer binds a live user, so deny (never free-tier).
    const { client } = mockApiKeys({}, { seedKeys: [seed] });
    const deleted = await resolveApiKeyContext("ak_test_valid_10", client);
    expect(deleted).toEqual({ type: "anonymous", authenticated: false });
    expect(requireAuth({ auth: deleted, requestId: "r" })?.status).toBe(401);

    // Transient (non-404) subject-read failure: the key itself verified, so
    // an unreadable tier must not lock it out — least-privilege free.
    const outage = mockApiKeys(
      { user_pro1: { tier: "pro", role: "user" } },
      {
        seedKeys: [
          {
            ...seed,
            id: "key_12",
            secret: "ak_test_valid_12",
            subject: "user_pro1",
          },
        ],
        failGet: new Error("clerk down"),
      },
    );
    const ctx = await resolveApiKeyContext("ak_test_valid_12", outage.client);
    expect(ctx).toMatchObject({
      type: "api_key",
      authenticated: true,
      userId: "user_pro1",
      tier: "free",
    });
  });

  test("full loop: issue → Bearer 200 → revoke → 401; rotation swaps cleanly", async () => {
    keylessEnv();
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    setApiKeysClient(client);

    // Issue key A via the admin handler.
    const issuedA = await handleAdminKeysCreate(
      "loop-issue-a",
      adminAuth,
      { subject: "user_pro1", name: "a" },
      { apiKeys: client },
    );
    expect(issuedA.status).toBe(200);
    const bodyA = (await issuedA.json()).data as {
      secret: string;
      keyId: string;
    };
    const secretA = bodyA.secret;
    const keyIdA = bodyA.keyId;

    // Call a protected surface with ak_* → resolved, allowed, 200 pattern.
    const ctxA = await clerkAuthProvider.resolve(bearerReq(secretA));
    expect(ctxA).toMatchObject({
      type: "api_key",
      authenticated: true,
      userId: "user_pro1",
      tier: "pro",
    });
    expect(requireAuth({ auth: ctxA, requestId: "loop-1" })).toBeUndefined();

    // Rotation: create-new (B, sharing the operator reason) + revoke-old
    // (A, same operator reason).
    const issuedB = await handleAdminKeysCreate(
      "loop-issue-b",
      adminAuth,
      { subject: "user_pro1", name: "b", reason: "rotation" },
      { apiKeys: client },
    );
    const bodyB = await issuedB.json();
    const revoked = await handleAdminKeysRevoke(
      "loop-revoke-a",
      adminAuth,
      keyIdA,
      { revocationReason: "rotation" },
      { apiKeys: client },
    );
    expect(revoked.status).toBe(200);

    // Old key fails (401 downstream), new key works.
    const ctxOld = await clerkAuthProvider.resolve(bearerReq(secretA));
    expect(ctxOld).toEqual({ type: "anonymous", authenticated: false });
    expect(requireAuth({ auth: ctxOld, requestId: "loop-2" })?.status).toBe(
      401,
    );
    const ctxNew = await clerkAuthProvider.resolve(
      bearerReq(bodyB.data.secret as string),
    );
    expect(ctxNew).toMatchObject({
      type: "api_key",
      authenticated: true,
      userId: "user_pro1",
    });
    expect(requireAuth({ auth: ctxNew, requestId: "loop-3" })).toBeUndefined();

    // Rotation is audited as issued + revoked with the shared reason.
    const actions = getAuditEvents().map((row) => row.action);
    expect(actions).toEqual([
      "api_key.issued",
      "api_key.issued",
      "api_key.revoked",
    ]);
    expect(getAuditEvents()[1]).toMatchObject({ reason: "rotation" });
    expect(getAuditEvents()[2]).toMatchObject({
      revocationReason: "rotation",
      reason: "rotation",
    });
  });
});

describe("admin keys HTTP wiring (Phase 05)", () => {
  function postReq(url: string, body: unknown, requestId: string): NextRequest {
    return new NextRequest(url, {
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
        "x-request-id": requestId,
      }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("all three admin routes 401 anonymously with contract headers", async () => {
    keylessEnv();
    const created = await keysPOST(
      postReq(
        "http://x/api/v1/admin/keys",
        { subject: "user_a1", name: "k" },
        "http-keys-401",
      ),
    );
    expect(created.status).toBe(401);
    expect(created.headers.get("X-Request-Id")).toBe("http-keys-401");
    expect((await created.json()).error.code).toBe("unauthenticated");

    const listed = await keysGET(
      new NextRequest("http://x/api/v1/admin/keys?subject=user_a1", {
        headers: { "x-request-id": "http-list-401" },
      }),
    );
    expect(listed.status).toBe(401);
    expect(listed.headers.get("X-Request-Id")).toBe("http-list-401");

    const revoked = await revokePOST(
      postReq("http://x/api/v1/admin/keys/key_1/revoke", {}, "http-revoke-401"),
      { params: Promise.resolve({ keyId: "key_1" }) },
    );
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("X-Request-Id")).toBe("http-revoke-401");
    expect((await revoked.json()).error.code).toBe("unauthenticated");
  });

  test("malformed JSON bodies are 400 invalid_body", async () => {
    keylessEnv();
    // The pipeline still invokes the handler for anonymous callers (the
    // handler's requireAdmin gate denies auth, but only after the route's
    // JSON parse) — garbage bytes fail at the parse branch first, exactly
    // like the Phase 04 tier/role routes.
    const res = await keysPOST(
      postReq("http://x/api/v1/admin/keys", "{not json", "http-keys-garbage"),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Request-Id")).toBe("http-keys-garbage");
    expect((await res.json()).error.code).toBe("invalid_body");
  });
});

describe("audit isolation for key rows (Phase 05)", () => {
  test("issued-row scopes are clones — callers cannot mutate the store", async () => {
    const users: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_pro1: { tier: "pro", role: "user" },
    };
    const { client } = mockApiKeys(users);
    await handleAdminKeysCreate(
      "keys-snap-1",
      adminAuth,
      { subject: "user_pro1", name: "k", scopes: ["search:read"] },
      { apiKeys: client },
    );
    const snapshot = getAuditEvents();
    expect(snapshot).toHaveLength(1);
    if (snapshot[0].action === "api_key.issued") {
      snapshot[0].scopes.push("tampered:write");
    }
    const reread = getAuditEvents();
    expect(reread).toHaveLength(1);
    if (reread[0].action === "api_key.issued") {
      expect(reread[0].scopes).toEqual(["search:read"]);
    } else {
      throw new Error("expected an api_key.issued row");
    }
  });
});
