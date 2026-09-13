# TubeLens — Plans, Tiers, Credits, Usage & Audit Model

This document is the source of truth for TubeLens product tiers, entitlement semantics, weighted-credit accounting, and the audit model used by Part B and future Part C MCP access.

## 1. Core ownership model

TubeLens uses separate systems for separate responsibilities:

- **Clerk** — authoritative user identity and the user's current product tier projection (`publicMetadata.tier`). Clerk session tokens expose the tier as a fast request-time claim.
- **Upstash Redis** — short-lived rate-limit windows, burst protection, hot counters, and fast enforcement state.
- **Postgres** — durable TubeLens product state only: plan definitions/versions, durable credit/usage ledger or summaries when enabled, projects, audit records, and future posting state.
- **Datadog** — operational observability only. It is never the authority for quota, billing, entitlement, security, or audit history.
- **CDN/in-memory cache** — response/transcript caching from Part A. Postgres is not introduced merely to cache transcripts.

> **Important:** the Clerk session token contains a tier claim for speed, but the underlying Clerk metadata is authoritative. Session claims can lag a server-side metadata change for roughly 60 seconds. For security-sensitive or immediately effective entitlement changes, the server must use the authoritative Clerk state or an explicit invalidation/refresh path instead of trusting a stale claim alone.

## 2. Tier model

All newly created TubeLens users are **Free by default**.

### Canonical metadata keys

Authoritative state lives in Clerk user `publicMetadata` with exactly two keys:

```json
{ "tier": "free|plus|pro|enterprise", "role": "admin|support|user" }
```

Tiers are ranked `free < plus < pro < enterprise`. `team` is an org concept, never a tier. Backend-written, UI-readable. Never use `unsafeMetadata` for roles/tier (client-writable). `privateMetadata` is reserved for future internal flags. Orgs are not used — `publicMetadata.role` is the admin signal.

Bootstrap the first `admin` out-of-band via the Clerk Dashboard (Users → target user → Public metadata) or via `clerkClient.users.updateUserMetadata()`. Never ship a self-grant endpoint.

### Active tier

| Tier | Status | Purpose |
|---|---|---|
| `free` | Active | Default for every user; enough allowance for experimentation and evaluation. |

### Reserved future tiers (ranked `free < plus < pro < enterprise`)

| Tier | Status | Purpose |
|---|---|---|
| `plus` | Defined, not active by default | Higher credit allowance and rate limits for power users. |
| `pro` | Defined, not active by default | Higher pooled allowance, developer-focused usage. |
| `enterprise` | Reserved | Custom contracts, controls, support, and limits. |

Do not implement paid billing merely because a tier exists in the enum. A tier can be defined before billing is enabled.

The initial implementation must make `free` the safe fallback if a user has no tier or has an invalid tier value.

## 3. Clerk session-token claim

Configure the Clerk session token via Dashboard → Sessions → Customize session token with a small custom claim projecting the authoritative tier:

```json
{
  "metadata": "{{user.public_metadata}}",
  "tubelens": {
    "tier": "{{user.public_metadata.tier}}"
  }
}
```

Prefer single small fields rather than copying large objects into the token. Keep total custom claims under 1.2KB (browser cookie size limits).

Read server-side with `auth()` from `@clerk/nextjs/server` (`const { userId, sessionClaims } = await auth()`), tier via `sessionClaims.tubelens.tier`, role via `sessionClaims.metadata.role`, typed through `types/globals.d.ts CustomJwtSessionClaims`. Prefer `auth()` + claims on hot paths; `currentUser()`/`getUser()` costs a Backend API call. Missing/invalid tier falls back to `free` — it can never self-escalate.

Later MCP auth (future `@xmcp-dev/clerk` spike, not now): `clerkProvider` in `src/middleware.ts` with JWKS Bearer verification; inside each tool call `getSession()` for fast claims and skip `getUser()` on the hot path; enable DCR in the Clerk Dashboard; same `tubelens.tier` claim and `free` fallback apply.

On user creation, initialize:

```json
{
  "tier": "free",
  "role": "user"
}
```

The claim is used by the request context for fast policy selection.

### Freshness rule

- Normal requests may use the session claim; fall back to `free` (and `user` role) on missing/invalid values — an invalid tier can never become an elevated plan.
- Claims lag ~60s after a metadata change. Fast paths may read claims; write paths must re-fetch authoritative state via `clerkClient.users.getUser()`.
- After a tier mutation, the UI should force a session refresh where appropriate.
- Server-side authorization that must take effect immediately must consult the authoritative Clerk metadata or an explicit server-side entitlement cache/invalidation mechanism.
- Never allow the client to directly modify `publicMetadata.tier`/`role`; Clerk public metadata is backend-writable and frontend-readable, making it appropriate for backend-controlled product state that the UI may display.

## 4. Tier and role administration endpoints

Tier and role changes are administrative product operations, not self-service user operations.

### Endpoints

```http
PATCH /api/v1/admin/users/:userId/tier
PATCH /api/v1/admin/users/:userId/role
```

Tier request (`tier: free|plus|pro|enterprise`):

```json
{
  "tier": "pro",
  "reason": "optional, max 280 chars"
}
```

Role request (`role: admin|support|user`):

```json
{
  "role": "support",
  "reason": "optional, max 280 chars"
}
```

### Authorization

- Caller must be authenticated (401 `unauthenticated` when signed out).
- Caller must have `publicMetadata.role === "admin"` (403 `forbidden` otherwise).
- The target `:userId` must match `/^user_[A-Za-z0-9]+$/` (400 `invalid_user_id`).
- Reject self-escalation: no caller-supplied field may change the caller's own privileges.
- Forbid self-demotion: `actor === target && role !== "admin"` → 403.
- Unknown tier → 400 `invalid_tier`; unknown role → 400 `invalid_role`.
- Never enforce admin checks only in `proxy.ts` (`proxy.ts` is not a complete authZ boundary, cf CVE-2025-29927); enforce inside the handler/service via `requireAdmin()`. Do not use `auth.protect()` in Route Handlers (throws 404) — return 401/403 manually.
- Tier and role changes must be audited.

### Implementation

Use Clerk's dedicated metadata update SDK, which wraps `PATCH /v1/users/{userId}/metadata` (deep-merge, `null` removes a key):

```ts
clerkClient.users.updateUserMetadata(userId, { publicMetadata: { tier } })
```

Since API version 2026-05-12, metadata is rejected on the general `updateUser()` path — the dedicated method is required.

Write only the minimal product metadata:

```json
{
  "publicMetadata": {
    "tier": "pro"
  }
}
```

Do not store usage counters, credit balances, API secrets, or audit history in Clerk metadata.

### Response

Return the effective tier plus an explicit freshness note when relevant:

```json
{
  "data": {
    "userId": "user_123",
    "tier": "pro",
    "sessionTokenMayRefreshWithinSeconds": 60
  }
}
```

The exact response should follow the existing TubeLens envelope conventions.

### References (Clerk docs the autonomous bot can read directly)

- Basic RBAC (roles via publicMetadata): https://clerk.com/docs/guides/secure/basic-rbac
- Update user metadata (dedicated method, `PATCH /v1/users/{userId}/metadata`): https://clerk.com/docs/reference/backend/user/update-user-metadata
- Customize session tokens (projection template): https://clerk.com/docs/guides/sessions/customize-session-tokens
- `auth()` in App Router Route Handlers: https://clerk.com/docs/nextjs/reference/app-router/auth
- Next.js authentication guide 2026: https://clerk.com/articles/nextjs-authentication-guide-2026 — note the 2026-05-12 API change: metadata is rejected on general `updateUser()` and must use the dedicated metadata method.

## 5. Self-service plan information

Expose a read-only endpoint for the current authenticated principal:

```http
GET /api/v1/me/plan
```

It should return:

- current tier;
- tier status;
- credit allowance/window;
- rate-limit policy summary;
- current usage;
- remaining credits;
- reset time;
- effective policy version.

This endpoint is informational. It must not mutate the tier.

## 6. Weighted-credit model

**Credit: Utkarsh's weighted-credit model idea** — TubeLens meters API consumption with a common credit unit rather than treating every HTTP request as equally expensive.

The starting policy is intentionally configurable:

| Operation class | Example | Starting cost |
|---|---|---:|
| Cheap read | `search`, `videos/:id` | 1 |
| Medium read | comments, channel/playlist pages | 2 |
| Expensive read | transcript or multi-upstream operation | 3 |
| Composed read | `combined` | 4 |
| Batch | sum of child costs | sum, capped |

These values are **policy defaults, not permanent pricing**. Real usage and upstream cost should determine later pricing.

Every metered request should resolve a policy record such as:

```ts
{
  operation: "videos.get",
  cost: 1,
  policyVersion: "2026-09-13.free.v1"
}
```

Store the policy version with durable usage records so historical accounting remains explainable after prices change.

## 7. Rate limit vs quota

These are deliberately different.

### Rate limit

Question:

> Can this principal make this request right now?

Primary system: **Upstash Redis**.

Examples:

```text
burst: 60 requests / 10 seconds
sustained: plan-specific weighted request rate
```

### Quota / credits

Question:

> How much of this plan's allowance has this principal consumed during the current period?

Primary systems:

```text
Redis      → fast enforcement / active window
Postgres   → durable accounting when durable accounting is required
```

A Redis limiter must not be mistaken for the permanent usage ledger.

## 8. Initial Free policy

The exact numbers are configuration and should be tuned after observing real traffic, but the first implementation must define one deterministic Free policy rather than leave behavior implicit.

Recommended starting shape:

```text
Tier: free
Monthly credits: 10,000
Burst: 60 requests / 10 seconds
Sustained weighted limit: configurable
Batch maximum: configurable hard cap
```

The numbers are experimental defaults. They must be centralized in policy configuration and never copied into individual routes.

## 9. What is accounted for

Account only product-level information that answers one of these questions:

### Usage accounting

- how many weighted credits were consumed;
- which logical operation consumed them;
- which account/user/project/key was responsible;
- which plan/tier policy was active;
- period/window ID;
- policy version;
- timestamp;
- whether the request was accepted, rejected, or partially fulfilled;
- batch child-cost summary.

### Security/account accounting

- API-key created;
- API-key revoked;
- API-key rotated if supported;
- user tier changed;
- project created/changed;
- authentication failures at useful aggregate granularity;
- authorization failures;
- suspicious/abuse-control actions;
- privileged/admin actions.

### Operational correlation

- request ID;
- route/tool name;
- status class;
- latency bucket/value where safe;
- upstream/provider outcome;
- cache hit/miss classification.

Do **not** account raw API secrets, bearer tokens, authorization headers, or unnecessary raw request content.

## 10. What we audit

An audit record is for **who changed privileged/security-sensitive state, what changed, when, and why/context**.

Audit these events at minimum:

- user tier changed;
- user/project entitlement changed;
- API key created;
- API key revoked;
- API key rotated;
- admin role/capability changed;
- project created/deleted;
- rate-limit policy changed;
- quota/credit policy changed;
- manual credit adjustment;
- billing entitlement override when billing exists;
- future posting/mutation actions;
- abuse block/unblock actions;
- security configuration changes.

Each audit entry should contain:

```text
id
actorUserId / actorPrincipal
actorType
action
resourceType
resourceId
timestamp
requestId
before (sanitized)
after (sanitized)
reason / source
```

Never put plaintext credentials or sensitive tokens into `before`/`after`.

## 11. What does NOT belong in the audit log

Do not create a durable audit row for every ordinary API read unless a later compliance requirement demands it. High-volume reads belong in operational metrics/logs and durable weighted-usage accounting, not an unbounded security audit table.

Do not use Datadog as the audit database. Datadog logs and traces may support an investigation, but the authoritative audit record belongs in durable product storage.

## 12. Durable Postgres model

Postgres should be introduced only when one or more durable product requirements need it.

Recommended logical tables:

```text
plans
plan_versions
usage_ledger              -- or durable usage summaries, depending on scale
projects
api_key_metadata          -- Clerk key reference only; never plaintext secret
audit_events
credit_adjustments       -- optional, when manual/admin credit grants exist
```

Possible relationships:

```text
Clerk user
   │
   ├── tier → Clerk publicMetadata/session claim
   │
   ├── projects → Postgres
   │      ├── usage → Redis + Postgres
   │      ├── keys → Clerk credential + Postgres metadata
   │      └── audit → Postgres
   │
   └── requests → rate limit in Redis + operational telemetry in Datadog
```

The first production implementation may omit any table that has no current durable requirement.

## 13. Transcript caching is separate

TubeLens transcript caching already has a strong Part A design: CDN + in-memory caching, stale-while-revalidate, and stale-on-error behavior.

Do **not** add Postgres merely to make transcript results durable.

A future durable transcript store may be introduced only after its own risk/cost gate proves it is necessary, for example because cache churn, provider reliability, or scale makes CDN/in-memory insufficient.

Therefore:

```text
transcript cache
    → CDN + in-memory by default

product state
    → Postgres when durable state is actually required
```

## 14. Policy-change behavior

Tier and policy changes must be versioned.

Never silently reinterpret historical usage with today's prices.

Example:

```text
2026-09-13
free.v1
transcript = 3 credits

2026-10-01
free.v2
transcript = 4 credits
```

A usage record keeps its policy version so support/admin tools can explain why a user's historical balance has a particular value.

## 15. Part B / Part C integration rule

Part C MCP is a **thin wrapper**: each tool authenticates the caller via Clerk, then calls the **same shared service functions** as the REST Route Handlers and returns the same data. No HTTP loopback to `localhost/api`, no separate business logic.

Part C MCP must consume the same tier, entitlement, quota, and rate-limit services as REST. Auth runs **before** tool execution; the shared `src/lib/auth.ts` (`AuthContext`, `getEffectiveTier`, `requireAuth`/`requireAdmin`) and `src/lib/quota.ts` (operation → cost map) serve REST first and MCP later. Envelope, cursor, and cache helpers are reused, not reimplemented.

There must be no separate:

```text
MCP quota
MCP tier
MCP rate limit
MCP user database
```

unless a future product requirement explicitly creates an MCP-specific policy. Even then, it should reference the same underlying identity and account model.

## 16. Auth/quota foundation (built for REST first, reused by MCP later)

Build these files during Part B so later MCP is a one-PR spike:

- `src/lib/auth.ts` — `AuthContext`, `getEffectiveTier()` (claim → ranked tier, fallback `free`), `requireAuth()`/`requireAdmin()` returning typed 401/403; consumed by REST handlers first, called by MCP tools later.
- `src/lib/quota.ts` — operation → cost map wrapping the weighted-credit stub; single source for REST + MCP charging.
- Reuse `src/lib/envelope`, `src/lib/cache`, cursor helpers in both surfaces.

Later MCP spike (one PR, after Part B): `bun add xmcp @xmcp-dev/clerk`, `clerkProvider` in `src/middleware.ts` (JWKS Bearer verify, DCR enabled in Clerk Dashboard), `/mcp` route whose tools call `getSession()` → `getEffectiveTier()` → shared service fns → same data as REST.
