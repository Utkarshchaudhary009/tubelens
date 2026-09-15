// Phase 07 (Part B): authorization matrix + resource ownership.
//
// Proves the horizontal (User A vs User B, cross-project/subject) and
// vertical (anonymous < user < support < admin, api_key never admin)
// boundaries are enforced server-side: direct handler calls (no UI),
// the pipeline authorization stage, and the key-route scoped lookups.
// Env + seam hygiene matches the Phase 04/05 suites.

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleAdminKeysRevoke } from "../../app/api/v1/admin/keys/[keyId]/revoke/route";
import {
  handleAdminKeysCreate,
  handleAdminKeysList,
} from "../../app/api/v1/admin/keys/route";
import { handleTierPatch } from "../../app/api/v1/admin/users/[userId]/tier/route";
import {
  type ApiKeyRecord,
  type ApiKeysClient,
  clearApiKeyMetadata,
  getKeyMetadata,
  recordKeyMetadata,
  resetApiKeysClient,
} from "../api-keys";
import { clearAuditEvents, getAuditEvents } from "../audit";
import { type AuthContext, requireAdmin } from "../auth";
import {
  can,
  requireOwnerOrAdmin,
  requireScope,
  toAuthorizationResponse,
} from "../authorize";
import { resolveApiKeyContext } from "../clerk-auth";
import { successResponse } from "../envelope";
import { withRequestContext } from "../pipeline";

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

const anonAuth: AuthContext = { type: "anonymous", authenticated: false };

const userA: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_aaa1",
  tier: "free",
  role: "user",
};

const userB: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_bbb2",
  tier: "free",
  role: "user",
};

const supportAuth: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_sup3",
  tier: "plus",
  role: "support",
};

const adminAuth: AuthContext = {
  type: "user",
  authenticated: true,
  userId: "user_admin1",
  tier: "pro",
  role: "admin",
};

const apiKeyAuth: AuthContext = {
  type: "api_key",
  authenticated: true,
  userId: "user_admin1",
  tier: "pro",
  keyId: "key_1",
  scopes: ["search:read"],
};

async function errorBody(res: Response): Promise<{ code: string }> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error;
}

// ---------------------------------------------------------------------------
// Matrix: public reads
// ---------------------------------------------------------------------------

describe("matrix public reads (Phase 07)", () => {
  test("read:public allows every principal including anonymous", () => {
    for (const ctx of [anonAuth, userA, supportAuth, adminAuth, apiKeyAuth]) {
      expect(can({ action: "read:public", ctx })).toEqual({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Matrix: ownership (horizontal boundary)
// ---------------------------------------------------------------------------

describe("matrix ownership (Phase 07)", () => {
  test("read:self allows the owner", () => {
    expect(
      can({
        action: "read:self",
        ctx: userA,
        resource: { ownerUserId: "user_aaa1" },
      }),
    ).toEqual({ ok: true });
  });

  test("User A resource vs User B cross-access → 403 denied", () => {
    const decision = can({
      action: "read:self",
      ctx: userB,
      resource: { ownerUserId: "user_aaa1" },
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "forbidden",
      status: 403,
    });
  });

  test("anonymous read:self → 401", () => {
    expect(
      can({
        action: "read:self",
        ctx: anonAuth,
        resource: { ownerUserId: "user_aaa1" },
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated", status: 401 });
  });

  test("admin access → allowed (vertical bypass)", () => {
    expect(
      can({
        action: "read:self",
        ctx: adminAuth,
        resource: { ownerUserId: "user_aaa1" },
      }),
    ).toEqual({ ok: true });
  });

  test("missing owner fails closed", () => {
    expect(can({ action: "read:self", ctx: userA })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  test("valid credential of another project → denied; admin → allowed", () => {
    const otherProject = { projectId: "proj_other" };
    expect(
      can({
        action: "read:self",
        ctx: userA,
        resource: { ownerUserId: "user_aaa1", ...otherProject },
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      can({ action: "read:public", ctx: userA, resource: otherProject }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      can({
        action: "read:self",
        ctx: adminAuth,
        resource: { ownerUserId: "user_aaa1", ...otherProject },
      }),
    ).toEqual({ ok: true });
  });

  test("requireOwnerOrAdmin delegates the same boundary", () => {
    expect(requireOwnerOrAdmin(userA, "user_aaa1")).toEqual({ ok: true });
    expect(requireOwnerOrAdmin(userB, "user_aaa1")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(requireOwnerOrAdmin(anonAuth, "user_aaa1")).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(requireOwnerOrAdmin(adminAuth, "user_aaa1")).toEqual({ ok: true });
  });

  test("toAuthorizationResponse maps denials via errorResponse, never throws", async () => {
    expect(toAuthorizationResponse("req-1", { ok: true })).toBeUndefined();
    const denied = toAuthorizationResponse(
      "req-2",
      requireOwnerOrAdmin(userB, "user_aaa1"),
    );
    expect(denied?.status).toBe(403);
    expect(denied?.headers.get("X-Request-Id")).toBe("req-2");
    expect(
      ((await denied?.json()) as { error: { code: string } }).error.code,
    ).toBe("forbidden");
  });

  test("denial responses carry X-RateLimit-* headers (pipeline contract)", async () => {
    // The pipeline's authorization-denial early return stamps the stub
    // allow-all decision, so a denied request still carries rate-limit
    // headers exactly like the success path. `toAuthorizationResponse`
    // output is the same object the pipeline stamps — assert the full set.
    const denied = toAuthorizationResponse(
      "req-rl",
      requireOwnerOrAdmin(userB, "user_aaa1"),
    );
    expect(denied?.headers.get("X-Request-Id")).toBe("req-rl");
    expect(denied?.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(denied?.headers.get("X-RateLimit-Remaining")).toBe("99");
    const reset = denied?.headers.get("X-RateLimit-Reset");
    expect(reset).not.toBeNull();
    expect(Number(reset)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Matrix: admin-only mutations, support read-vs-mutate, api_key never admin
// ---------------------------------------------------------------------------

describe("matrix admin mutations (Phase 07)", () => {
  const mutations = [
    "keys:issue",
    "keys:revoke",
    "users:mutate-tier",
    "users:mutate-role",
  ] as const;

  test("admin allowed on every mutation", () => {
    for (const action of mutations) {
      expect(can({ action, ctx: adminAuth })).toEqual({ ok: true });
    }
  });

  test("support read-vs-mutate boundary: may list, may NOT mutate", () => {
    expect(can({ action: "keys:list", ctx: supportAuth })).toEqual({
      ok: true,
    });
    for (const action of mutations) {
      const decision = can({ action, ctx: supportAuth });
      expect(decision).toMatchObject({
        ok: false,
        code: "forbidden",
        status: 403,
      });
    }
  });

  test("api_key principal can never administer, even for an admin subject", () => {
    for (const action of ["keys:list", ...mutations] as const) {
      expect(can({ action, ctx: apiKeyAuth })).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    // Route-level gate agrees (maps to 401 unauthenticated — fail-closed either way).
    expect(requireAdmin(apiKeyAuth)).toEqual({
      ok: false,
      code: "unauthenticated",
    });
  });

  test("plain user denied, anonymous → 401", () => {
    for (const action of mutations) {
      expect(can({ action, ctx: userA })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(can({ action, ctx: anonAuth })).toMatchObject({
        ok: false,
        status: 401,
      });
    }
  });

  test("unknown/future action fails closed for everyone including admin", () => {
    for (const action of ["write:comments", "admin:nuke", ""]) {
      expect(can({ action, ctx: adminAuth })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(can({ action, ctx: userA })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(can({ action, ctx: anonAuth })).toMatchObject({
        ok: false,
        status: 401,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Scope gate (future write scopes)
// ---------------------------------------------------------------------------

describe("requireScope (Phase 07)", () => {
  test("admin user passes without any scopes; anonymous → 401", () => {
    expect(requireScope(adminAuth, "write:comments")).toEqual({ ok: true });
    expect(requireScope(anonAuth, "write:comments")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  test("api_key passes only with the granted scope", () => {
    expect(requireScope(apiKeyAuth, "search:read")).toEqual({ ok: true });
    expect(requireScope(apiKeyAuth, "write:comments")).toMatchObject({
      ok: false,
      code: "forbidden",
      status: 403,
    });
    expect(
      requireScope({ ...apiKeyAuth, scopes: undefined }, "search:read"),
    ).toMatchObject({ ok: false, status: 403 });
  });

  test("privileged scope strings never authorize api_key administration", () => {
    const privilegedKey: AuthContext = {
      ...apiKeyAuth,
      scopes: ["users:mutate-role", "keys:list", "search:read"],
    };
    for (const scope of [
      "users:mutate-role",
      "users:mutate-tier",
      "keys:issue",
      "keys:revoke",
      "keys:list",
    ]) {
      expect(requireScope(privilegedKey, scope)).toMatchObject({
        ok: false,
        code: "forbidden",
        status: 403,
      });
    }
    // Non-privileged scopes still use membership alone.
    expect(requireScope(privilegedKey, "search:read")).toEqual({ ok: true });
    // Inherited property names are not privileged actions: a granted scope
    // colliding with one (e.g. "toString") passes by membership.
    expect(
      requireScope(
        { ...apiKeyAuth, scopes: ["toString", "constructor"] },
        "toString",
      ),
    ).toEqual({ ok: true });
  });

  test("non-admin session user denied", () => {
    expect(requireScope(userA, "search:read")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  test("resolveApiKeyContext projects verified scopes onto the context", async () => {
    const record: ApiKeyRecord = {
      id: "key_9",
      name: "scoped",
      subject: "user_aaa1",
      scopes: ["write:comments"],
      claims: null,
      revoked: false,
      revocationReason: null,
      expired: false,
      expiration: null,
      createdBy: "user_admin1",
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const client = {
      async getUser(userId: string) {
        return { id: userId, publicMetadata: { tier: "free" as const } };
      },
      async createKey(): Promise<ApiKeyRecord> {
        throw new Error("unused");
      },
      async listKeys() {
        return { keys: [], truncated: false };
      },
      async revokeKey(): Promise<ApiKeyRecord> {
        throw new Error("unused");
      },
      async verifyKey(): Promise<ApiKeyRecord> {
        return record;
      },
    } satisfies ApiKeysClient;
    const ctx = await resolveApiKeyContext("ak_test_secret", client);
    expect(ctx.type).toBe("api_key");
    expect(ctx.scopes).toEqual(["write:comments"]);
    expect(requireScope(ctx, "write:comments")).toEqual({ ok: true });
    expect(requireScope(ctx, "admin:keys")).toMatchObject({ status: 403 });
  });
});

// ---------------------------------------------------------------------------
// Direct-HTTP denial (no UI): tier/role + key routes
// ---------------------------------------------------------------------------

describe("direct-HTTP denial (Phase 07)", () => {
  test("non-admin tier mutate → 403; anonymous → 401; api_key → 401", async () => {
    for (const [ctx, status, code] of [
      [userB, 403, "forbidden"],
      [supportAuth, 403, "forbidden"],
      [anonAuth, 401, "unauthenticated"],
      [apiKeyAuth, 401, "unauthenticated"],
    ] as const) {
      const res = await handleTierPatch("req-denied", ctx, "user_aaa1", {
        tier: "pro",
      });
      expect(res.status).toBe(status);
      expect((await errorBody(res)).code).toBe(code);
    }
  });

  test("api_key principal denied on all three key routes", async () => {
    const create = await handleAdminKeysCreate("req-k1", apiKeyAuth, {
      subject: "user_aaa1",
      name: "cron",
    });
    expect(create.status).toBe(401);
    const list = await handleAdminKeysList("req-k2", apiKeyAuth, "user_aaa1");
    expect(list.status).toBe(401);
    const revoke = await handleAdminKeysRevoke(
      "req-k3",
      apiKeyAuth,
      "key_1",
      {},
    );
    expect(revoke.status).toBe(401);
  });

  test("support denied on mutate/list routes (routes stay stricter than the matrix floor)", async () => {
    const tier = await handleTierPatch("req-s1", supportAuth, "user_aaa1", {
      tier: "pro",
    });
    expect(tier.status).toBe(403);
    const list = await handleAdminKeysList("req-s2", supportAuth, "user_aaa1");
    expect(list.status).toBe(403);
    const revoke = await handleAdminKeysRevoke(
      "req-s3",
      supportAuth,
      "key_1",
      {},
    );
    expect(revoke.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Scoped lookups: issuance owner binding, revoke verification, list filter
// ---------------------------------------------------------------------------

interface MockKeyState {
  id: string;
  subject: string;
  scopes: string[];
}

function mockKeys(
  users: Record<string, { tier?: unknown; role?: unknown }>,
  seeds: MockKeyState[] = [],
  opts: { revokeSubject?: string } = {},
): ApiKeysClient {
  const toRecord = (state: MockKeyState): ApiKeyRecord => ({
    id: state.id,
    name: state.id,
    subject: opts.revokeSubject ?? state.subject,
    scopes: [...state.scopes],
    claims: null,
    revoked: true,
    revocationReason: null,
    expired: false,
    expiration: null,
    createdBy: "user_admin1",
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return {
    async getUser(userId) {
      const meta = users[userId];
      if (!meta) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return { id: userId, publicMetadata: { ...meta } };
    },
    async createKey(params) {
      const id = `key_${params.subject}`;
      return {
        ...toRecord({
          id,
          subject: params.subject,
          scopes: params.scopes ?? [],
        }),
        revoked: false,
        secret: "ak_test_secret_once",
      };
    },
    async listKeys(_params) {
      return { keys: seeds.map(toRecord), truncated: false };
    },
    async revokeKey(params) {
      const seed = seeds.find((key) => key.id === params.apiKeyId);
      if (!seed) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return toRecord(seed);
    },
    async verifyKey() {
      throw Object.assign(new Error("invalid api key"), { status: 401 });
    },
  };
}

describe("scoped key lookups (Phase 07)", () => {
  test("issuance binds createdBy === caller; tier-rank self-grant stays", async () => {
    const apiKeys = mockKeys({
      user_admin1: { tier: "pro", role: "admin" },
      user_aaa1: { tier: "free", role: "user" },
    });
    const res = await handleAdminKeysCreate(
      "req-issue",
      adminAuth,
      { subject: "user_aaa1", name: "cron" },
      { apiKeys },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { keyId: string } };
    expect(getKeyMetadata(body.data.keyId)).toMatchObject({
      subject: "user_aaa1",
      createdBy: "user_admin1",
      tierAtIssuance: "free",
    });
    // Self-grant: free-tier admin cannot mint for an enterprise subject.
    const lowAdmin: AuthContext = { ...adminAuth, userId: "user_low9" };
    const poor = mockKeys({
      user_low9: { tier: "free", role: "admin" },
      user_rich9: { tier: "enterprise", role: "user" },
    });
    const deniedRes = await handleAdminKeysCreate(
      "req-issue2",
      lowAdmin,
      { subject: "user_rich9", name: "cron" },
      { apiKeys: poor },
    );
    expect(deniedRes.status).toBe(403);
  });

  test("issuance verifies authority subject: divergence → 409, cleanup, no leak", async () => {
    const users = {
      user_admin1: { tier: "pro", role: "admin" },
      user_aaa1: { tier: "free", role: "user" },
    };
    const base = mockKeys(users);
    let revokeCalls = 0;
    const divergent: ApiKeysClient = {
      ...base,
      async createKey(params, opts) {
        const rec = await base.createKey(params, opts);
        return { ...rec, subject: "user_other9" };
      },
      async revokeKey(params) {
        revokeCalls += 1;
        return {
          id: params.apiKeyId,
          name: "cron",
          subject: "user_other9",
          scopes: [],
          claims: null,
          revoked: true,
          revocationReason: params.revocationReason ?? null,
          expired: false,
          expiration: null,
          createdBy: "user_admin1",
          createdAt: Date.now(),
          lastUsedAt: null,
        };
      },
    };
    const res = await handleAdminKeysCreate(
      "req-issue-divergent",
      adminAuth,
      { subject: "user_aaa1", name: "cron" },
      { apiKeys: divergent },
    );
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect((JSON.parse(raw) as { error: { code: string } }).error.code).toBe(
      "key_owner_mismatch",
    );
    // Cleanup ran, nothing identifying the requested subject was stored, and
    // the secret never appears in the failure body.
    expect(revokeCalls).toBe(1);
    expect(getKeyMetadata("key_user_aaa1")).toBeUndefined();
    expect(
      getAuditEvents().some((event) => event.action === "api_key.issued"),
    ).toBe(false);
    expect(raw).not.toContain("ak_test_secret_once");
  });

  test("revoke verifies subject/owner: match → 200, mismatch → 409", async () => {
    const users = { user_admin1: { tier: "pro", role: "admin" } };
    // Match path: overlay subject agrees with the authority.
    recordKeyMetadata({
      keyId: "key_user_aaa1",
      subject: "user_aaa1",
      name: "cron",
      scopes: [],
      tierAtIssuance: "free",
      createdBy: "user_admin1",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revoked: false,
      lastUsedAt: null,
    });
    const apiKeys = mockKeys(users, [
      { id: "key_user_aaa1", subject: "user_aaa1", scopes: [] },
    ]);
    const ok = await handleAdminKeysRevoke(
      "req-r1",
      adminAuth,
      "key_user_aaa1",
      {},
      { apiKeys },
    );
    expect(ok.status).toBe(200);
    // Mismatch path: authority reports another subject → 409 conflict.
    recordKeyMetadata({
      keyId: "key_user_bbb2",
      subject: "user_bbb2",
      name: "cron",
      scopes: [],
      tierAtIssuance: "free",
      createdBy: "user_admin1",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revoked: false,
      lastUsedAt: null,
    });
    const divergentBase = mockKeys(
      users,
      [{ id: "key_user_bbb2", subject: "user_bbb2", scopes: [] }],
      { revokeSubject: "user_aaa1" },
    );
    // Wrap the authority revoke to prove the 409 below does not skip it.
    let authorityRevokes = 0;
    const divergent: ApiKeysClient = {
      ...divergentBase,
      async revokeKey(params, opts) {
        authorityRevokes += 1;
        return divergentBase.revokeKey(params, opts);
      },
    };
    const conflict = await handleAdminKeysRevoke(
      "req-r2",
      adminAuth,
      "key_user_bbb2",
      {},
      { apiKeys: divergent },
    );
    expect(conflict.status).toBe(409);
    expect((await errorBody(conflict)).code).toBe("key_owner_mismatch");
    // The 409 reports the divergence, but the authority revoke was applied
    // and bookkeeping is intact: exactly one authority call plus an
    // `api_key.revoked` audit row carrying the authority's subject.
    expect(authorityRevokes).toBe(1);
    expect(getKeyMetadata("key_user_bbb2")).toMatchObject({ revoked: true });
    const revokedRows = getAuditEvents().flatMap((event) =>
      event.action === "api_key.revoked" ? [event] : [],
    );
    expect(
      revokedRows.some(
        (row) => row.keyId === "key_user_bbb2" && row.target === "user_aaa1",
      ),
    ).toBe(true);
  });

  test("list cross-check withholds foreign-subject rows with a warning", async () => {
    const users = { user_admin1: { tier: "pro", role: "admin" } };
    const apiKeys = mockKeys(users, [
      { id: "key_a", subject: "user_aaa1", scopes: [] },
      { id: "key_b", subject: "user_bbb2", scopes: [] },
    ]);
    const res = await handleAdminKeysList("req-l1", adminAuth, "user_aaa1", {
      apiKeys,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { keyId: string; subject: string }[];
      warnings: { code?: string }[];
    };
    expect(body.data.map((row) => row.subject)).toEqual(["user_aaa1"]);
    expect(body.warnings.map((warning) => warning.code)).toContain(
      "subject_mismatch",
    );
    // Clean listing stays warning-free (Phase 05 contract).
    const cleanKeys = mockKeys(users, [
      { id: "key_a", subject: "user_aaa1", scopes: [] },
    ]);
    const clean = await handleAdminKeysList("req-l2", adminAuth, "user_aaa1", {
      apiKeys: cleanKeys,
    });
    expect(((await clean.json()) as { warnings: unknown[] }).warnings).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Pipeline authorization stage: public behavior unchanged
// ---------------------------------------------------------------------------

describe("pipeline authorization stage (Phase 07)", () => {
  test("anonymous public read still serves byte/shape-compatible", async () => {
    const handler = withRequestContext(
      (_req, ctx) =>
        successResponse({ hello: "world" }, { requestId: ctx.requestId }),
      {
        auth: {
          resolve(): AuthContext {
            return { ...anonAuth };
          },
        },
      },
      "probe",
    );
    const res = await handler(
      new NextRequest("http://x/api/v1/search?q=cats", {
        headers: new Headers(),
      }),
    );
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-Id");
    if (typeof requestId !== "string") {
      throw new Error("expected an X-Request-Id response header");
    }
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    const body = (await res.json()) as {
      data: unknown;
      page: { next: null };
      meta: { requestId: string };
      warnings: unknown[];
    };
    expect(body.data).toEqual({ hello: "world" });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(requestId);
    expect(body.warnings).toEqual([]);
  });

  test("forced pipeline authorization denial carries X-Request-Id + X-RateLimit-*", async () => {
    // The `authorizationAction` override (tests only) swaps the baseline so
    // the pipeline takes its real early-return denial branch: the handler
    // never runs, yet the denial still carries the full header contract.
    let handlerRan = false;
    const handler = withRequestContext(
      (_req, ctx) => {
        handlerRan = true;
        return successResponse(
          { hello: "world" },
          { requestId: ctx.requestId },
        );
      },
      {
        auth: {
          resolve(): AuthContext {
            return { ...anonAuth };
          },
        },
      },
      "probe",
      { authorizationAction: "users:mutate-role" },
    );
    const sent = new Headers();
    sent.set("x-request-id", "probe-deny-1");
    const res = await handler(
      new NextRequest("http://x/api/v1/search?q=cats", { headers: sent }),
    );
    expect(handlerRan).toBe(false);
    expect(res.status).toBe(401);
    expect((await errorBody(res)).code).toBe("unauthenticated");
    expect(res.headers.get("X-Request-Id")).toBe("probe-deny-1");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    const reset = res.headers.get("X-RateLimit-Reset");
    expect(reset).not.toBeNull();
    expect(Number(reset)).toBeGreaterThan(0);
  });
});
