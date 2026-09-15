import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  handleRolePatch,
  roleBodySchema,
  PATCH as rolePATCH,
} from "../../app/api/v1/admin/users/[userId]/role/route";
import {
  handleTierPatch,
  tierBodySchema,
  PATCH as tierPATCH,
} from "../../app/api/v1/admin/users/[userId]/tier/route";
import { clearAuditEvents, getAuditEvents, recordAuditEvent } from "../audit";
import {
  type AuthContext,
  getEffectiveRole,
  normalizeRole,
  requireAdmin,
} from "../auth";
import {
  type ClerkAdminClient,
  resetClerkAdminClient,
  withBudget,
} from "../clerk-admin";
import { contextFromClerkSession } from "../clerk-auth";
import { getEffectiveTier } from "../product";

// Env + seam hygiene: tests inject a mocked Clerk backend and touch the
// audit store — always reset so later files see a clean keyless env.
const savedEnforcement = process.env.TUBELENS_AUTH_ENFORCEMENT;
const savedSecret = process.env.CLERK_SECRET_KEY;
const savedPublishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

afterEach(() => {
  resetClerkAdminClient();
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

type MockMeta = { tier?: unknown; role?: unknown };

/**
 * Mocked Clerk backend seam: authoritative metadata lives in `store`, so
 * tests control exactly what `getUser` returns (including values that differ
 * from the caller's stale session claim). Records every call's fail-fast
 * signal for assertions, plus write params to pin owned-key-only updates.
 */
function mockClerk(
  store: Record<string, MockMeta>,
  opts: { failGet?: unknown; failUpdate?: unknown } = {},
): {
  client: ClerkAdminClient;
  seen: { op: string; signal: unknown; params?: unknown }[];
} {
  const seen: { op: string; signal: unknown; params?: unknown }[] = [];
  const client: ClerkAdminClient = {
    async getUser(userId, o) {
      seen.push({ op: "getUser", signal: o?.signal });
      if (opts.failGet !== undefined) {
        throw opts.failGet;
      }
      const meta = store[userId];
      if (!meta) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return { id: userId, publicMetadata: { ...meta } };
    },
    async updateUserMetadata(userId, params, o) {
      seen.push({ op: "updateUserMetadata", signal: o?.signal, params });
      if (opts.failUpdate !== undefined) {
        throw opts.failUpdate;
      }
      store[userId] = { ...(store[userId] ?? {}), ...params.publicMetadata };
      return {
        id: userId,
        publicMetadata: { ...(store[userId] as Record<string, unknown>) },
      };
    },
  };
  return { client, seen };
}

function patchReq(url: string, body: unknown, requestId?: string): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (requestId !== undefined) {
    headers.set("x-request-id", requestId);
  }
  return new NextRequest(url, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("admin body schemas (Phase 04)", () => {
  test("tier schema accepts every canonical tier with/without reason", () => {
    for (const tier of ["free", "plus", "pro", "enterprise"] as const) {
      expect(tierBodySchema.safeParse({ tier }).success).toBe(true);
      expect(
        tierBodySchema.safeParse({ tier, reason: "annual plan upgrade" })
          .success,
      ).toBe(true);
    }
  });

  test("role schema accepts every canonical role with/without reason", () => {
    for (const role of ["admin", "support", "user"] as const) {
      expect(roleBodySchema.safeParse({ role }).success).toBe(true);
      expect(
        roleBodySchema.safeParse({ role, reason: "hired to support" }).success,
      ).toBe(true);
    }
  });

  test("schemas reject unknown tier/role values (team is never a tier)", () => {
    for (const tier of ["team", "Plus", "PRO", "admin", "", 42, null]) {
      expect(tierBodySchema.safeParse({ tier }).success).toBe(false);
    }
    for (const role of ["owner", "Admin", "tier", "", 42, null]) {
      expect(roleBodySchema.safeParse({ role }).success).toBe(false);
    }
  });

  test("schemas reject over-long reason", () => {
    const long = "x".repeat(281);
    expect(
      tierBodySchema.safeParse({ tier: "pro", reason: long }).success,
    ).toBe(false);
    expect(
      roleBodySchema.safeParse({ role: "user", reason: long }).success,
    ).toBe(false);
    const ok = "x".repeat(280);
    expect(tierBodySchema.safeParse({ tier: "pro", reason: ok }).success).toBe(
      true,
    );
  });

  test("strict schemas deny smuggled privilege keys", () => {
    // A caller cannot slip the *other* field (or any extra key) past the body.
    expect(
      tierBodySchema.safeParse({ tier: "pro", role: "admin" }).success,
    ).toBe(false);
    expect(
      roleBodySchema.safeParse({ role: "user", tier: "enterprise" }).success,
    ).toBe(false);
    expect(
      tierBodySchema.safeParse({ tier: "pro", isAdmin: true }).success,
    ).toBe(false);
  });
});

describe("role claim projection (Phase 04)", () => {
  test("normalizeRole passes canonical roles, falls back to user", () => {
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("support")).toBe("support");
    expect(normalizeRole("user")).toBe("user");
    for (const raw of [undefined, null, "", "owner", "ADMIN", 42, true, {}]) {
      expect(normalizeRole(raw)).toBe("user");
    }
  });

  test("getEffectiveRole reads metadata.role, free of throws", () => {
    expect(getEffectiveRole({ metadata: { role: "admin" } })).toBe("admin");
    expect(getEffectiveRole({ metadata: { role: "support" } })).toBe("support");
    for (const claims of [
      undefined,
      null,
      {},
      { metadata: null },
      { metadata: {} },
      { metadata: { role: "owner" } },
      "admin",
      42,
    ]) {
      expect(getEffectiveRole(claims)).toBe("user");
    }
    const throwing = {
      get metadata(): unknown {
        throw new Error("poisoned getter");
      },
    };
    expect(getEffectiveRole(throwing)).toBe("user");
  });

  test("contextFromClerkSession projects role alongside tier", () => {
    expect(
      contextFromClerkSession({
        userId: "user_a1",
        sessionClaims: {
          tubelens: { tier: "pro" },
          metadata: { role: "admin" },
        },
      }),
    ).toMatchObject({
      type: "user",
      authenticated: true,
      userId: "user_a1",
      tier: "pro",
      role: "admin",
    });
    // Invalid role claim keeps the user signed in at least privilege.
    expect(
      contextFromClerkSession({
        userId: "user_b1",
        sessionClaims: { metadata: { role: "owner" } },
      }),
    ).toMatchObject({ authenticated: true, tier: "free", role: "user" });
  });

  test("getEffectiveTier still falls back to free on missing/invalid", () => {
    expect(getEffectiveTier(undefined)).toBe("free");
    expect(getEffectiveTier({ tubelens: { tier: "team" } })).toBe("free");
    expect(getEffectiveTier({ tubelens: { tier: "pro" } })).toBe("pro");
  });
});

describe("requireAdmin gate (Phase 04)", () => {
  test("admin user principal succeeds with userId + role", () => {
    expect(requireAdmin(adminAuth)).toEqual({
      ok: true,
      userId: "user_admin1",
      role: "admin",
    });
  });

  test("signed-in non-admin is forbidden (never escalates)", () => {
    for (const role of ["user", "support", undefined, "owner"]) {
      expect(requireAdmin({ ...userAuth, role })).toEqual({
        ok: false,
        code: "forbidden",
      });
    }
  });

  test("anonymous caller is unauthenticated", () => {
    expect(requireAdmin(anonAuth)).toEqual({
      ok: false,
      code: "unauthenticated",
    });
  });

  test("non-user principals are unauthenticated even with a subject userId", () => {
    expect(
      requireAdmin({
        type: "api_key",
        authenticated: true,
        userId: "user_admin1",
        role: "admin",
        keyId: "key_1",
      }),
    ).toEqual({ ok: false, code: "unauthenticated" });
    expect(
      requireAdmin({ type: "user", authenticated: true, role: "admin" }),
    ).toEqual({ ok: false, code: "unauthenticated" });
  });
});

describe("PATCH tier happy path (Phase 04)", () => {
  test("200 upgrades free → pro, preserves role, audits, no-store", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_target1: { tier: "free", role: "user" },
    };
    const { client, seen } = mockClerk(store);
    const res = await handleTierPatch(
      "tier-happy-1",
      adminAuth,
      "user_target1",
      { tier: "pro", reason: "annual plan upgrade" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("tier-happy-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({
      userId: "user_target1",
      tier: "pro",
      sessionTokenMayRefreshWithinSeconds: 60,
    });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe("tier-happy-1");
    // Authoritative write preserved the untouched role key.
    expect(store.user_target1).toEqual({ tier: "pro", role: "user" });
    // Fail-fast signals travelled with every Clerk call — one fresh 8s
    // budget per call, never a shared leftover: caller check, target read,
    // then the write.
    expect(seen.map((s) => s.op)).toEqual([
      "getUser",
      "getUser",
      "updateUserMetadata",
    ]);
    for (const s of seen) {
      expect(s.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(seen.map((s) => s.signal)).size).toBe(3);
    // Owned-key-only write: the untouched role is never resent, so a
    // concurrent role change cannot be clobbered with a stale value.
    expect(seen.find((s) => s.op === "updateUserMetadata")?.params).toEqual({
      publicMetadata: { tier: "pro" },
    });
    // One sanitized audit row.
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user.tier.changed",
      actor: "user_admin1",
      target: "user_target1",
      targetUserId: "user_target1",
      oldTier: "free",
      newTier: "pro",
      requestId: "tier-happy-1",
      reason: "annual plan upgrade",
    });
    expect(typeof rows[0].id).toBe("string");
    expect(typeof rows[0].ts).toBe("string");
    const flat = JSON.stringify(rows[0]);
    for (const secret of ["secret", "token", "password", "unsafeMetadata"]) {
      expect(flat.toLowerCase()).not.toContain(secret);
    }
  });

  test("admin may change their own tier (documented: tier is not privilege)", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "free", role: "admin" },
    };
    const { client } = mockClerk(store);
    const res = await handleTierPatch(
      "tier-self-1",
      adminAuth,
      "user_admin1",
      { tier: "plus" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.tier).toBe("plus");
  });
});

describe("PATCH role happy path (Phase 04)", () => {
  test("200 promotes user → support, preserves tier, audits, no-store", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_target2: { tier: "pro", role: "user" },
    };
    const { client, seen } = mockClerk(store);
    const res = await handleRolePatch(
      "role-happy-1",
      adminAuth,
      "user_target2",
      { role: "support", reason: "hired to support" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("role-happy-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.data).toEqual({
      userId: "user_target2",
      role: "support",
      sessionTokenMayRefreshWithinSeconds: 60,
    });
    expect(body.page).toEqual({ next: null });
    expect(store.user_target2).toEqual({ tier: "pro", role: "support" });
    expect(seen.map((s) => s.op)).toEqual([
      "getUser",
      "getUser",
      "updateUserMetadata",
    ]);
    for (const s of seen) {
      expect(s.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(seen.map((s) => s.signal)).size).toBe(3);
    // Owned-key-only write: the untouched tier is never resent.
    expect(seen.find((s) => s.op === "updateUserMetadata")?.params).toEqual({
      publicMetadata: { role: "support" },
    });
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user.role.changed",
      actor: "user_admin1",
      target: "user_target2",
      targetUserId: "user_target2",
      oldRole: "user",
      newRole: "support",
      requestId: "role-happy-1",
      reason: "hired to support",
    });
  });

  test("admin re-affirming their own admin role is allowed", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
    };
    const { client } = mockClerk(store);
    const res = await handleRolePatch(
      "role-self-admin-1",
      adminAuth,
      "user_admin1",
      { role: "admin" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
  });
});

describe("admin auth matrix (Phase 04)", () => {
  test("401 signed-out on both routes", async () => {
    const { client } = mockClerk({});
    for (const run of [
      () =>
        handleTierPatch(
          "t401",
          anonAuth,
          "user_x1",
          { tier: "pro" },
          { clerk: client },
        ),
      () =>
        handleRolePatch(
          "r401",
          anonAuth,
          "user_x1",
          { role: "user" },
          { clerk: client },
        ),
    ]) {
      const res = await run();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthenticated");
      expect(body.meta.requestId).toBeDefined();
    }
    // No Clerk call, no audit row when signed out.
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("403 non-admin on both routes", async () => {
    const { client } = mockClerk({ user_x2: { tier: "free", role: "user" } });
    for (const run of [
      () =>
        handleTierPatch(
          "t403",
          userAuth,
          "user_x2",
          { tier: "pro" },
          { clerk: client },
        ),
      () =>
        handleRolePatch(
          "r403",
          userAuth,
          "user_x2",
          { role: "support" },
          { clerk: client },
        ),
    ]) {
      const res = await run();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("forbidden");
      expect(body.error.hint).toBeString();
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("403 self-demotion on the role route only", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
    };
    const { client } = mockClerk(store);
    for (const role of ["user", "support"]) {
      const res = await handleRolePatch(
        `self-demote-${role}`,
        adminAuth,
        "user_admin1",
        { role },
        { clerk: client },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toMatch(/self-demotion/i);
    }
    // Blocked before any Clerk write and before any audit row.
    expect(store.user_admin1).toEqual({ tier: "pro", role: "admin" });
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("403 demoted caller: admin claim but authoritative role is user", async () => {
    // The session claim still says admin (~60s lag) but authoritative
    // metadata was already demoted: the write must fail closed.
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "user" },
      user_demo1: { tier: "free", role: "user" },
    };
    const { client, seen } = mockClerk(store);
    for (const run of [
      () =>
        handleTierPatch(
          "demoted-tier",
          adminAuth,
          "user_demo1",
          { tier: "pro" },
          { clerk: client },
        ),
      () =>
        handleRolePatch(
          "demoted-role",
          adminAuth,
          "user_demo1",
          { role: "support" },
          { clerk: client },
        ),
    ]) {
      const res = await run();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toMatch(/no longer valid/i);
    }
    // Fail closed before touching the target: no write, no audit row, and
    // the target was never even read.
    expect(seen.some((s) => s.op === "updateUserMetadata")).toBe(false);
    expect(store.user_demo1).toEqual({ tier: "free", role: "user" });
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("503 when the authoritative caller check itself fails", async () => {
    const { client } = mockClerk({}, { failGet: new Error("clerk down") });
    const res = await handleTierPatch(
      "caller-check-down",
      adminAuth,
      "user_demo2",
      { tier: "pro" },
      { clerk: client },
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("dependency_unavailable");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("HTTP PATCH wiring 401s anonymously with contract headers", async () => {
    keylessEnv();
    const tierRes = await tierPATCH(
      patchReq(
        "http://x/api/v1/admin/users/user_t1/tier",
        { tier: "pro" },
        "http-tier-401",
      ),
      { params: Promise.resolve({ userId: "user_t1" }) },
    );
    expect(tierRes.status).toBe(401);
    expect(tierRes.headers.get("X-Request-Id")).toBe("http-tier-401");
    expect((await tierRes.json()).error.code).toBe("unauthenticated");

    const roleRes = await rolePATCH(
      patchReq(
        "http://x/api/v1/admin/users/user_t1/role",
        { role: "user" },
        "http-role-401",
      ),
      { params: Promise.resolve({ userId: "user_t1" }) },
    );
    expect(roleRes.status).toBe(401);
    expect(roleRes.headers.get("X-Request-Id")).toBe("http-role-401");
    expect((await roleRes.json()).error.code).toBe("unauthenticated");
  });
});

describe("admin input validation (Phase 04)", () => {
  test("400 invalid_user_id on both routes", async () => {
    const { client } = mockClerk({});
    for (const bad of ["", "abc", "user_", "user_a b", "user-a!", "usr_123"]) {
      for (const run of [
        () =>
          handleTierPatch(
            `t-${bad}`,
            adminAuth,
            bad,
            { tier: "pro" },
            { clerk: client },
          ),
        () =>
          handleRolePatch(
            `r-${bad}`,
            adminAuth,
            bad,
            { role: "user" },
            { clerk: client },
          ),
      ]) {
        const res = await run();
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe("invalid_user_id");
      }
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("400 invalid_tier maps enum violations, not generic messages", async () => {
    const { client } = mockClerk({ user_t3: { tier: "free", role: "user" } });
    for (const tier of ["team", "Plus", "owner", 42, null]) {
      const res = await handleTierPatch(
        "t-bad-tier",
        adminAuth,
        "user_t3",
        { tier },
        { clerk: client },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_tier");
      expect(body.error.hint).toMatch(/free, plus, pro, enterprise/);
      expect(body.error.status).toBe(400);
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("400 invalid_role maps enum violations, not generic messages", async () => {
    const { client } = mockClerk({ user_r3: { tier: "free", role: "user" } });
    for (const role of ["owner", "Admin", "enterprise", 42, null]) {
      const res = await handleRolePatch(
        "r-bad-role",
        adminAuth,
        "user_r3",
        { role },
        { clerk: client },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_role");
      expect(body.error.hint).toMatch(/admin, support, user/);
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("400 invalid_reason on over-long reason; invalid_body on smuggled keys", async () => {
    const { client } = mockClerk({ user_t4: { tier: "free", role: "user" } });
    const longRes = await handleTierPatch(
      "t-long-reason",
      adminAuth,
      "user_t4",
      { tier: "pro", reason: "x".repeat(281) },
      { clerk: client },
    );
    expect(longRes.status).toBe(400);
    expect((await longRes.json()).error.code).toBe("invalid_reason");

    const smuggledTier = await handleTierPatch(
      "t-smuggled",
      adminAuth,
      "user_t4",
      { tier: "pro", role: "admin" },
      { clerk: client },
    );
    expect(smuggledTier.status).toBe(400);
    expect((await smuggledTier.json()).error.code).toBe("invalid_body");

    const smuggledRole = await handleRolePatch(
      "r-smuggled",
      adminAuth,
      "user_t4",
      { role: "support", tier: "enterprise" },
      { clerk: client },
    );
    expect(smuggledRole.status).toBe(400);
    expect((await smuggledRole.json()).error.code).toBe("invalid_body");
    expect(getAuditEvents()).toHaveLength(0);
  });
});

describe("authoritative write path + stale claims (Phase 04)", () => {
  test("write path uses getUser state, not the stale session claim", async () => {
    // Caller session still projects the OLD tier (free) while authoritative
    // metadata already moved to pro: the audit old-value must be pro.
    const staleAdmin: AuthContext = { ...adminAuth, tier: "free" };
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_stale1: { tier: "pro", role: "user" },
    };
    const { client } = mockClerk(store);
    const res = await handleTierPatch(
      "stale-1",
      staleAdmin,
      "user_stale1",
      { tier: "enterprise" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldTier: "pro", newTier: "enterprise" });
  });

  test("missing/invalid authoritative values normalize safely, never escalate", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_weird1: { tier: "team", role: "owner" },
    };
    const { client } = mockClerk(store);
    const res = await handleRolePatch(
      "weird-1",
      adminAuth,
      "user_weird1",
      { role: "support" },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    // Owned-key-only write: the unrecognized authoritative tier is preserved
    // untouched, never normalize-rewritten to free.
    expect(store.user_weird1).toEqual({ tier: "team", role: "support" });
    expect(getAuditEvents()[0]).toMatchObject({
      oldRole: "user",
      newRole: "support",
    });
  });

  test("unknown target maps to 404 user_not_found with no audit row", async () => {
    const { client } = mockClerk({
      user_admin1: { tier: "pro", role: "admin" },
    });
    const res = await handleTierPatch(
      "missing-target-1",
      adminAuth,
      "user_ghost1",
      { tier: "pro" },
      { clerk: client },
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
    const { client } = mockClerk({}, { failGet: timeout });
    const res = await handleTierPatch(
      "timeout-1",
      adminAuth,
      "user_t5",
      { tier: "pro" },
      { clerk: client },
    );
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("upstream_timeout");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("backend outage maps to 503 dependency_unavailable with no audit row", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_t6: { tier: "free", role: "user" },
    };
    const { client } = mockClerk(store, {
      failUpdate: new Error("clerk down"),
    });
    const res = await handleTierPatch(
      "outage-1",
      adminAuth,
      "user_t6",
      { tier: "pro" },
      { clerk: client },
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("dependency_unavailable");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("Clerk 429 maps to 429 rate_limited with Retry-After", async () => {
    const limited = Object.assign(new Error("too many requests"), {
      status: 429,
      retryAfter: 30,
    });
    const { client } = mockClerk({}, { failGet: limited });
    const res = await handleRolePatch(
      "limited-1",
      adminAuth,
      "user_t7",
      { role: "support" },
      { clerk: client },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.status).toBe(429);
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("Clerk 4xx validation fault passes through, never a 503", async () => {
    const rejected = Object.assign(new Error("unprocessable"), { status: 422 });
    const { client } = mockClerk({}, { failGet: rejected });
    const res = await handleTierPatch(
      "rejected-1",
      adminAuth,
      "user_t8",
      { tier: "pro" },
      { clerk: client },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("clerk_rejected");
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("whitespace-only reason is trimmed and dropped from the audit row", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_t9: { tier: "free", role: "user" },
    };
    const { client } = mockClerk(store);
    const res = await handleTierPatch(
      "blank-reason-1",
      adminAuth,
      "user_t9",
      { tier: "pro", reason: "   " },
      { clerk: client },
    );
    expect(res.status).toBe(200);
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    expect("reason" in rows[0]).toBe(false);
  });

  test("Clerk 401/403 describe our backend credential → 503, never caller 4xx", async () => {
    for (const status of [401, 403]) {
      const denied = Object.assign(new Error("backend credential rejected"), {
        status,
      });
      const { client } = mockClerk({}, { failGet: denied });
      const res = await handleTierPatch(
        `cred-${status}`,
        adminAuth,
        "user_t10",
        { tier: "pro" },
        { clerk: client },
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("dependency_unavailable");
      expect(body.error.hint).toMatch(/backend credential/);
    }
    expect(getAuditEvents()).toHaveLength(0);
  });

  test("timed-out write confirmed by re-fetch audits and returns 504 + warning", async () => {
    // The write lands server-side but the response is lost: the handler's
    // single bounded re-fetch sees the new value, audits it, and answers 504
    // with reconciled_after_timeout instead of silently dropping the row.
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_rec1: { tier: "free", role: "user" },
    };
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const seen: { op: string }[] = [];
    const client: ClerkAdminClient = {
      async getUser(userId) {
        seen.push({ op: "getUser" });
        const meta = store[userId];
        if (!meta) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        return { id: userId, publicMetadata: { ...meta } };
      },
      async updateUserMetadata(userId, params) {
        seen.push({ op: "updateUserMetadata" });
        store[userId] = { ...(store[userId] ?? {}), ...params.publicMetadata };
        throw timeout;
      },
    };
    const res = await handleTierPatch(
      "reconciled-1",
      adminAuth,
      "user_rec1",
      { tier: "pro" },
      { clerk: client },
    );
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.data.tier).toBe("pro");
    expect(body.warnings).toMatchObject([{ code: "reconciled_after_timeout" }]);
    const rows = getAuditEvents();
    expect(rows).toHaveLength(1);
    // Attribution: the re-fetch cannot prove THIS request caused the value,
    // so the row carries the reconciled action, never a confirmed change.
    expect(rows[0]).toMatchObject({
      action: "user.tier.change_reconciled",
      oldTier: "free",
      newTier: "pro",
      requestId: "reconciled-1",
    });
  });

  test("timed-out write with unchanged re-fetch returns 504 + no audit row", async () => {
    const store: Record<string, MockMeta> = {
      user_admin1: { tier: "pro", role: "admin" },
      user_rec2: { tier: "free", role: "user" },
    };
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const { client } = mockClerk(store, { failUpdate: timeout });
    const res = await handleRolePatch(
      "unknown-outcome-1",
      adminAuth,
      "user_rec2",
      { role: "support" },
      { clerk: client },
    );
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_timeout");
    expect(body.error.hint).toMatch(/Outcome unknown/);
    expect(getAuditEvents()).toHaveLength(0);
  });
});

describe("audit snapshot isolation + fail-fast budget (Phase 04)", () => {
  test("getAuditEvents rows are clones — callers cannot mutate the store", () => {
    recordAuditEvent({
      action: "user.tier.changed",
      actor: "user_admin1",
      target: "user_snap1",
      targetUserId: "user_snap1",
      oldTier: "free",
      newTier: "pro",
      requestId: "snap-1",
    });
    const snapshot = getAuditEvents();
    expect(snapshot).toHaveLength(1);
    snapshot[0].actor = "user_tampered";
    snapshot.push(snapshot[0]);
    const reread = getAuditEvents();
    expect(reread).toHaveLength(1);
    expect(reread[0].actor).toBe("user_admin1");
  });

  test("withBudget fails bounded when acquisition never resolves", async () => {
    // A stalled lazy-load/SDK init counts against the same budget as the
    // call itself: the race rejects on timeout instead of hanging.
    const start = Date.now();
    const err = await withBudget(
      () => new Promise<never>(() => {}),
      AbortSignal.timeout(50),
    ).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("withBudget rejects before starting when the signal is already dead", async () => {
    let started = false;
    const controller = new AbortController();
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const err = await withBudget(() => {
      started = true;
      return Promise.resolve(1);
    }, controller.signal).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(started).toBe(false);
    expect((err as DOMException).name).toBe("TimeoutError");
  });
});
