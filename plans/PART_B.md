# TubeLens — Part B: Identity, Access, Usage & Product Intelligence

Part B is the product/account platform layer that sits between the completed REST API (Part A) and the MCP layer (Part C).

**Goal:** turn the API from a public collection of routes into a controlled developer product with identity, machine authentication, quota/rate limiting, usage visibility, product analytics, and a foundation for future posting/mutations.

**Primary systems:**
- **Clerk** — user identity, sessions, organizations/roles where needed, and machine-token verification.
- **Upstash Redis** — distributed rate limiting, short-lived counters, abuse controls, and optional ephemeral usage state.
- **PostHog** — product analytics, funnels, feature adoption, activation, experiments, and backend/API usage analytics.
- **Postgres** — durable product data that must survive process restarts: API keys/metadata if not stored by Clerk, plans, entitlements, usage summaries, audit records, and future posting-related state. Use the selected hosted/free-tier Postgres in production only where durable state is actually required.
- **Vercel** — application/runtime deployment.

> **Architecture rule:** authentication, authorization, rate limiting, quota, analytics, and durable product state are separate concerns. Do not use PostHog as the source of truth for security/billing/usage, and do not use Redis as the durable product database.

> **Testing rule:** local/CI E2E may run Redis, Postgres, PostHog, and other required dependencies in isolated Docker containers/networks. Production architecture must not inherit test-only dependencies or state.

## B1 — Platform foundation and boundaries

**Status:** `[ ]` not started.

**Goal:** establish the shared request context and clean boundaries before adding providers.

**Implementation:**
- Define canonical request context containing request ID, auth principal, plan/entitlements, rate-limit identity, and analytics identity.
- Establish explicit layers: `auth` → `authorization` → `rate-limit/quota` → `service` → `analytics` → response.
- Keep provider-specific code isolated under `src/lib/auth`, `src/lib/rate-limit`, `src/lib/analytics`, and `src/lib/product`.
- Do not put provider calls directly in individual endpoint business logic.
- Define environment/config validation for Clerk, Redis, PostHog, and Postgres.
- Define fail-open/fail-closed rules per dependency before implementation.

**Exit criteria:**
- A representative REST request can flow through the new context without changing successful API output.
- Existing Part A tests remain green.
- Missing optional analytics configuration does not break public API functionality; missing security-critical configuration fails safely.

## B2 — Clerk user authentication

**Status:** `[ ]` not started.

**Goal:** add first-class user identity to the Next.js application.

**Implementation:**
- Integrate the current Clerk Next.js SDK using the Next.js 16 `proxy.ts` convention.
- Configure Clerk middleware for request context, while keeping authorization checks close to protected Route Handlers/resources.
- Add sign-in, sign-up, sign-out, and account/profile flows needed by the developer product.
- Normalize Clerk identity into the internal `AuthContext` without leaking Clerk-specific objects throughout the codebase.
- Define anonymous vs authenticated access policy for every existing REST endpoint.
- Never expose `CLERK_SECRET_KEY` to client code.

**Exit criteria:**
- Signed-out users can use explicitly public routes.
- Protected product routes require valid Clerk authentication.
- User identity is stable and available to server-side product services.
- Unauthorized requests return the API's typed error contract rather than HTML redirects.

## B3 — Machine authentication and API-key model

**Status:** `[ ]` not started.

**Goal:** make TubeLens usable by scripts, backend services, and future MCP clients without tying machine access to a browser session.

**Implementation:**
- Use Clerk-supported machine authentication where appropriate and define the canonical accepted credential types.
- Add a TubeLens developer API-key model with opaque, revocable credentials if the product needs dedicated API keys separate from Clerk session tokens.
- Store only non-secret key metadata and a secure verifier/hash where durable key storage is required; show plaintext secrets only once at creation time.
- Give each key a stable ID, owner, creation time, last-used time, status, plan/entitlement binding, and optional environment label.
- Support immediate revocation and rotation.
- Ensure API credentials work consistently with REST and remain compatible with the future Part C MCP endpoint.

**Exit criteria:**
- A machine request authenticates without a browser session.
- Revoked keys stop working immediately or within the documented propagation window.
- Credentials never appear in logs, PostHog events, error payloads, or telemetry.

## B4 — Distributed rate-limit engine

**Status:** `[ ]` not started.

**Goal:** build a genuinely strong serverless-safe rate-limit layer rather than a per-process counter.

**Implementation:**
- Use Upstash Redis through its HTTP-based rate-limit tooling so limits work across Vercel/serverless instances.
- Centralize all policy in `src/lib/rate-limit/policies.ts`; routes declare cost/class, not raw algorithms.
- Apply multiple dimensions where appropriate: anonymous IP, authenticated user, API key, organization/project, and protected endpoint class.
- Use endpoint/request costs instead of treating every request as equal.
- Start with a burst limit plus a sustained window; prefer a sliding-window or token-bucket policy where it materially improves fairness.
- Support dynamic policies by plan and endpoint class without redeploying code.
- Add deny-list/abuse controls for obviously hostile clients where supported.
- Decide and document dependency failure behavior: rate limiting must fail safely rather than accidentally turning a Redis outage into unlimited expensive traffic.

**Suggested initial cost model:**
- cheap metadata/search read: `1`
- comments/large list/transcript: `2–3`
- expensive composed or multi-upstream read: `3–5`
- batch: sum the protected subrequest costs, with a hard maximum
- health/operational probes: dedicated low-cost policy

**Exit criteria:**
- Limits are enforced consistently across multiple application instances.
- Costly routes consume more quota than cheap routes.
- Switching IPs or tools does not bypass identity/key-level protection.
- Burst traffic is controlled without punishing normal short bursts of legitimate use.
- 429 responses include `Retry-After` and the existing `X-RateLimit-*` metadata.

## B5 — Quota, plans, entitlements and usage accounting

**Status:** `[ ]` not started.

**Goal:** separate short-term rate limiting from durable product usage and prepare for pricing without hard-coding a billing system.

**Implementation:**
- Define plans/entitlements independently from Clerk user records.
- Represent usage as weighted credits/units rather than raw request count.
- Redis handles hot-window enforcement; durable storage records data that must survive restarts or support account-level reporting.
- Define monthly/daily windows, rollover/reset behavior, and the authoritative source for each metric.
- Record enough durable metadata to explain why a request was accepted or denied.
- Expose the existing `/api/v1/quota` semantics consistently for authenticated developers.
- Make batch quota accounting deterministic and resistant to partial-request abuse.

**Exit criteria:**
- A user can understand remaining allowance and reset time.
- Rate limit and quota decisions are reproducible from server state.
- Usage cannot be inflated by switching credentials or deployment instances.
- The system can later add paid plans without changing every route.

## B6 — PostHog product analytics foundation

**Status:** `[ ]` not started.

**Goal:** instrument the product around activation and retention, not collect random event spam.

**Implementation:**
- Integrate PostHog on the browser using the Next.js-recommended client entry point.
- Add a small typed event registry under `src/lib/analytics/events.ts`.
- Add a server-side PostHog client for API/backend events.
- Identify authenticated users using stable Clerk user IDs, never email addresses as the primary identity.
- Reset analytics identity on logout.
- Define the first product funnel:
  `landing_viewed → signup_completed → api_key_created → first_api_request → successful_api_request`.
- Define activation/retention events around actual product value, not vanity clicks.
- Keep event capture non-blocking and prevent analytics outages from breaking API responses.

**Exit criteria:**
- One authenticated developer has a coherent identity across web and server events.
- The signup → first successful API request funnel is measurable.
- Analytics can be disabled in local/test environments without affecting application correctness.

## B7 — API usage analytics and operational intelligence

**Status:** `[ ]` not started.

**Goal:** make PostHog useful for product decisions and make the backend measurable without turning PostHog into an operational database.

**Server events should include:**
- `api_request`
- `api_error`
- `api_rate_limited`
- `quota_exhausted`
- `api_key_created`
- `api_key_revoked`
- feature-adoption events for high-value capabilities such as transcript, combined, batch, and future MCP

**Useful properties:**
- logical endpoint/tool name
- HTTP method or operation type
- status class
- latency bucket or bounded latency value
- auth type
- plan
- request cost
- cache hit/miss classification where useful
- safe country/region classification only when legitimately needed

**Rules:**
- Never send secrets, authorization headers, API keys, raw tokens, full request URLs with sensitive query material, or raw user content unless separately justified.
- Do not use PostHog data as authoritative quota/billing/security state.
- Sample noisy low-value events if volume becomes excessive.

**Exit criteria:**
- Product can answer which endpoints drive activation and continued usage.
- Product can identify top error/rate-limit pain points.
- Analytics failure never causes an API request to fail.

## B8 — Developer dashboard, usage visibility and controls

**Status:** `[ ]` not started.

**Goal:** give authenticated developers direct control over the platform they are consuming.

**Implementation:**
- Developer account area backed by Clerk identity.
- API-key creation, listing, rotation, and revocation.
- Current plan and entitlement display.
- Quota/usage summary and reset information.
- Recent request/usage summary where durable data is available.
- Clear rate-limit and quota error explanations.
- Security-sensitive actions require fresh authentication where appropriate.
- PostHog feature flags may control gradual rollout of dashboard capabilities.

**Exit criteria:**
A developer can sign in, create a credential, make an API request, see usage, understand a rate-limit response, and revoke the credential without touching the database or deployment manually.

## B9 — Posting/mutation readiness and security hardening

**Status:** `[ ]` not started.

**Goal:** establish safe foundations for future posting/mutation features without prematurely shipping risky write capabilities.

**Implementation:**
- Define an authorization matrix for read vs write operations.
- Establish role/permission checks at the resource/service boundary, not only in UI code.
- Add an audit-event model for security-sensitive mutations such as credential creation/revocation and future posting actions.
- Add idempotency requirements for future POST operations where retries could duplicate effects.
- Define CSRF/origin requirements for browser-authenticated mutation endpoints.
- Separate user-generated content from analytics telemetry.
- Add abuse limits stricter than read limits for future mutation endpoints.
- Keep any YouTube write/auth flows behind explicit product, abuse, and legal gates.

**Exit criteria:**
- The codebase has a documented authorization matrix.
- Security-sensitive mutations are auditable.
- No write endpoint can accidentally bypass the common auth/rate-limit layer.
- Future posting can be added without redesigning identity or quota primitives.

## B10 — Full integration, E2E, observability and production gate

**Status:** `[ ]` not started.

**Goal:** prove that identity, rate limiting, quota, analytics, durable state, and the existing REST API work together in a real multi-service environment.

**E2E environment:**
- GitHub E2E runs may use Docker Compose or standalone Docker containers.
- The E2E agent is explicitly allowed to start temporary **Redis, Postgres, PostHog, and other required supporting services** for the test.
- Containers must use isolated names/networks/volumes and be cleaned up after the run.
- Test credentials and seeded data must be disposable.
- Clerk cloud integration may use dedicated test credentials or a deterministic test seam; do not fabricate production Clerk secrets.

**Mandatory scenarios:**
- anonymous request and anonymous rate-limit enforcement;
- authenticated Clerk user request;
- machine/API-key request;
- revoked credential;
- multiple application instances sharing Redis limits;
- weighted endpoint costs;
- burst + sustained limit behavior;
- quota reset/remaining calculation;
- PostHog server event capture;
- PostHog outage does not break API responses;
- Redis outage follows the documented safety policy;
- Postgres restart/reconnect preserves durable product state;
- API key creation/revocation reflected in authorization;
- no credential leakage into logs or analytics payloads;
- existing Part A REST regression suite remains green.

**Production gate:**
- Clerk authentication and authorization are enforced at the resource boundary.
- Distributed rate limits work across Vercel instances.
- Quota semantics are documented and deterministic.
- PostHog identity/event funnels are verified in a non-production or controlled production project.
- Durable data has backup/retention expectations appropriate to its purpose.
- All security-sensitive events have request IDs/audit context.
- 401/403/429 behavior is consistent and machine-readable.
- Docs explain authentication, API keys, quotas, rate limits, and usage.
- Rollback and key-revocation procedures are tested.

**Definition of done:**
TubeLens has a production-ready identity and platform layer: users can authenticate with Clerk, machines can authenticate safely, distributed rate limits protect the API, durable quota/usage rules support future plans, PostHog gives actionable product intelligence, and future posting/mutation capabilities have a secure foundation — without coupling security or billing truth to analytics.