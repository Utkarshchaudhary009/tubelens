# TubeLens — Part B: Identity, Access, Usage & Observability

Part B is the product/account platform layer that sits between the completed REST API (Part A) and the MCP layer (Part C).

**Goal:** turn the API from a public collection of routes into a controlled developer product with identity, machine authentication, quota/rate limiting, operational observability, usage visibility, and a foundation for future posting/mutations.

**Primary systems:**
- **Clerk** — user identity, sessions, API keys, organizations/roles where needed, and machine authentication.
- **Upstash Redis** — distributed rate limiting, short-lived counters, abuse controls, and optional ephemeral usage state.
- **Postgres** — durable product data only: plans, entitlements, durable usage summaries/ledger data, audit records, project metadata, and future posting-related state. **Postgres is not the default transcript cache.** Part A transcript caching remains CDN + in-memory by default; a durable transcript store is a separate, explicitly gated decision.
- **Datadog** — backend observability: traces/APM, structured logs, metrics, error monitoring, service health, latency, and infrastructure correlation.
- **Vercel** — application/runtime deployment.

> **Deferred:** PostHog is intentionally not part of Part B. Add PostHog after the UI/marketing/product surface exists, when funnels, feature adoption, experiments, and user-journey analytics become more valuable.

> **Architecture rule:** authentication, authorization, rate limiting, quota, observability, durable product state, and transcript caching are separate concerns. Datadog is observability, not the source of truth for security/billing/usage. Redis is not the durable product database. Do not introduce Postgres merely to persist cache entries that can remain in CDN/in-memory storage.

> **Testing rule:** local/CI E2E may run Redis, Postgres, Datadog-compatible telemetry stubs/collectors, and other required dependencies in isolated Docker containers/networks. Production architecture must not inherit test-only dependencies or state.

## B1 — Platform foundation and boundaries

**Status:** `[ ]` not started.

**Goal:** establish the shared request context and clean boundaries before adding providers.

**Implementation:**
- Define canonical request context containing request ID, auth principal, plan/entitlements, rate-limit identity, and observability context.
- Establish explicit layers: `auth` → `authorization` → `rate-limit/quota` → `service` → `observability` → response.
- Keep provider-specific code isolated under `src/lib/auth`, `src/lib/rate-limit`, `src/lib/observability`, and `src/lib/product`.
- Do not put provider calls directly in individual endpoint business logic.
- Define environment/config validation for Clerk, Redis, Datadog, and Postgres only when the feature requiring Postgres is enabled.
- Define fail-open/fail-closed rules per dependency before implementation.

**Exit criteria:**
- A representative REST request can flow through the new context without changing successful API output.
- Existing Part A tests remain green.
- Missing optional observability configuration does not break public API functionality; missing security-critical configuration fails safely.

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
- Prefer **Clerk API Keys** for developer credentials where they fit the product model. Clerk provides API-key creation and management for users/organizations; use those primitives instead of inventing a parallel credential authority.
- Treat Clerk as the authoritative credential system. TubeLens stores only metadata needed for product behavior: Clerk API-key reference, owner/project, environment/label, plan binding, creation time, last-used time, and status.
- **Do not store plaintext API-key secrets in Postgres or anywhere else.** The newly created secret is shown/returned according to Clerk's supported lifecycle and is not persisted by TubeLens.
- Only introduce a separate TubeLens key vault/hash model if a concrete requirement cannot be satisfied by Clerk API Keys; document that decision before implementation.
- Support immediate revocation/rotation through the authoritative credential provider.
- Ensure API credentials work consistently with REST and remain compatible with the future Part C MCP endpoint.

**Exit criteria:**
- A machine request authenticates without a browser session.
- Revoked keys stop working immediately or within the documented propagation window.
- Credentials never appear in logs, Datadog events, error payloads, or telemetry.
- TubeLens-specific key metadata remains queryable independently of credential secrecy.

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

## B5 — Quota, plans, entitlements and weighted-credit accounting

**Status:** `[ ]` not started.

**Goal:** separate short-term rate limiting from durable product usage and prepare for pricing without hard-coding a billing system.

**Implementation:**
- Define plans/entitlements independently from Clerk user records.
- Use **weighted credits/units instead of raw request count** so quota reflects the actual cost/value of operations.
- **Credit: Utkarsh's weighted-credit model idea** — TubeLens should meter API consumption with a common credit system, where cheap and expensive operations consume different numbers of credits.
- Example starting policy: `search=1`, `video=1`, `comments=2`, `transcript=3`, `combined=4`, and `batch=sum(subrequest costs)` with a hard ceiling. Treat these as policy defaults to validate with real traffic, not permanent pricing.
- Redis handles hot-window enforcement and short-lived counters.
- **Postgres is introduced only where durable product state is actually required**: plan configuration, durable usage/credit ledger or summaries, account/project metadata, audits, or future billing/posting state. It is not required merely because transcript caching exists.
- Keep Part A transcript cache separate: CDN + in-memory remains the default; durable transcript persistence requires its own risk/cost gate.
- Define monthly/daily windows, rollover/reset behavior, and the authoritative source for each metric.
- Record enough durable metadata to explain why a request was accepted or denied when durable accounting is enabled.
- Expose the existing `/api/v1/quota` semantics consistently for authenticated developers.
- Make batch quota accounting deterministic and resistant to partial-request abuse.

**Important distinction:**
- **Rate limit:** "Can this principal make this request right now?" → primarily Redis.
- **Quota/credits:** "How much of this plan's allowance has this principal consumed?" → durable accounting when required, with Redis used for fast enforcement.
- **Cache:** "Can we avoid repeating an upstream fetch?" → Part A CDN/in-memory first; do not force Postgres into this path.

**Exit criteria:**
- A user can understand remaining allowance and reset time.
- Rate-limit and quota decisions are reproducible from server state.
- Usage cannot be inflated by switching credentials or deployment instances.
- The system can later add paid plans without changing every route.
- Postgres is not required in environments that do not enable durable product accounting.

## B6 — Datadog observability foundation

**Status:** `[ ]` not started.

**Goal:** make backend behavior visible enough to operate the API reliably before a full UI/product analytics stack exists.

**Implementation:**
- Integrate Datadog's current Node/Next.js tracing path using `dd-trace` for Node runtime code; keep tracing initialization isolated from application business logic.
- Add structured application logging with request ID, route, status, latency, auth type, rate-limit result, cache result, and upstream dependency context.
- Capture traces for REST Route Handlers and important service/upstream operations.
- Define service/environment/version tags so deploys and incidents can be correlated.
- Add error monitoring and exception context without recording credentials or raw sensitive input.
- Add custom metrics for request volume, latency, 4xx/5xx rates, upstream failures, cache hit rate, rate-limit rejections, and quota exhaustion.
- Configure sampling intentionally; do not collect every noisy event forever by default.
- Keep observability asynchronous/non-critical where possible so Datadog degradation cannot take down the API.

**Exit criteria:**
- A request can be followed from incoming API route through important service/upstream spans.
- Errors show enough context to diagnose the responsible route/dependency.
- p50/p95/p99 latency can be inspected for the major API groups.
- No API key, token, authorization header, or sensitive request content is emitted.

## B7 — API reliability and operational intelligence

**Status:** `[ ]` not started.

**Goal:** turn Datadog from "logs are somewhere" into an operational feedback system.

**Dashboards:**
- API overview: traffic, p50/p95/p99 latency, error rate, saturation.
- Endpoint health: latency/error distribution by logical endpoint.
- Upstream health: YouTube/third-party provider latency, status codes, timeouts.
- Rate limiting: rejected requests, hottest identities, policy hits, Redis latency/errors.
- Quota: consumption, exhaustion events, high-cost endpoints.
- Deployment health: version-to-version error/latency comparisons.

**Monitors / alerts:**
- sustained 5xx spike;
- p95 latency regression;
- abnormal upstream failure rate;
- Redis/rate-limit dependency failure;
- quota/rate-limit anomalies;
- elevated authentication failures;
- production deployment regression.

**Rules:**
- Prefer server-side operational telemetry over product-behavior analytics at this stage.
- Use bounded/sanitized attributes instead of raw request content.
- Correlate logs and traces using request/trace identifiers.

**Exit criteria:**
- An engineer can answer "what is broken?", "where?", and "since which deploy?" from Datadog without reproducing the incident locally.
- Important operational regressions generate actionable alerts rather than dashboard-only signals.

## B8 — Developer dashboard, usage visibility and controls

**Status:** `[ ]` not started.

**Goal:** give authenticated developers direct control over the platform they are consuming.

**Implementation:**
- Developer account area backed by Clerk identity.
- API-key creation, listing, rotation, and revocation using Clerk-backed credentials.
- Current plan and entitlement display.
- Quota/usage summary and reset information.
- Recent request/usage summary where durable data is available.
- Clear rate-limit and quota error explanations.
- Security-sensitive actions require fresh authentication where appropriate.
- Keep the UI independent of Datadog; Datadog remains an operator-facing system.

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
- Separate user-generated content from observability telemetry.
- Add abuse limits stricter than read limits for future mutation endpoints.
- Keep any YouTube write/auth flows behind explicit product, abuse, and legal gates.

**Exit criteria:**
- The codebase has a documented authorization matrix.
- Security-sensitive mutations are auditable.
- No write endpoint can accidentally bypass the common auth/rate-limit layer.
- Future posting can be added without redesigning identity or quota primitives.

## B10 — Full integration, E2E, observability and production gate

**Status:** `[ ]` not started.

**Goal:** prove that identity, rate limiting, quota, observability, durable state, and the existing REST API work together in a real multi-service environment.

**E2E environment:**
- GitHub E2E runs may use Docker Compose or standalone Docker containers.
- The E2E agent is explicitly allowed to start temporary **Redis, Postgres, Datadog-compatible telemetry collectors/stubs, and other required supporting services** for the test.
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
- Datadog server trace/log/metric emission;
- Datadog outage does not break API responses;
- Redis outage follows the documented safety policy;
- Postgres restart/reconnect preserves durable product state where Postgres is enabled;
- API key creation/revocation reflected in authorization;
- no credential leakage into logs or telemetry;
- existing Part A REST regression suite remains green.

**Production gate:**
- Clerk authentication and authorization are enforced at the resource boundary.
- Distributed rate limits work across Vercel instances.
- Quota semantics are documented and deterministic.
- Datadog traces/logs/metrics are verified for the main API paths.
- Durable data has backup/retention expectations appropriate to its purpose.
- All security-sensitive events have request IDs/audit context.
- 401/403/429 behavior is consistent and machine-readable.
- Docs explain authentication, API keys, quotas, rate limits, and operational expectations.
- Rollback and key-revocation procedures are tested.

**Definition of done:**
TubeLens has a production-ready identity and platform layer: users can authenticate with Clerk, machines can authenticate safely, distributed rate limits protect the API, weighted-credit quota rules support future plans, Datadog provides actionable backend observability, and future posting/mutation capabilities have a secure foundation — without coupling security, billing, or cache truth to observability tooling or an unnecessary Postgres dependency.
