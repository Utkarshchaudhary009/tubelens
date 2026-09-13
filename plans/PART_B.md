# TubeLens — Part B: Secure API Platform, Identity, Usage & Observability

Part B is the platform/security layer between the completed REST API (Part A) and the MCP layer (Part C).

**Goal:** turn TubeLens from a collection of working REST routes into a secure, observable, abuse-resistant developer API with identity, machine authentication, authorization, distributed rate limiting, weighted-credit quotas, durable product state, operational visibility, and a safe foundation for future posting/mutations.

**Primary systems:**
- **Clerk** — user identity, sessions, API keys, organizations/roles where needed, and machine authentication.
- **Upstash Redis** — distributed rate limiting, short-lived counters, burst/sustained enforcement, and abuse controls.
- **Postgres** — durable product state only: plans, policy versions, durable usage/credit accounting, projects, audit events, and future posting-related state. **Postgres is not the default transcript cache.** Part A transcript caching remains CDN + in-memory by default.
- **Datadog** — backend observability: traces/APM, structured logs, metrics, error monitoring, service health, and alerts.
- **Vercel** — application/runtime deployment.

> **Canonical plans and usage source of truth:** [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md). It defines Free/default tier behavior, future tiers, Clerk tier claims, tier management, weighted credits, quota semantics, usage/audit data, and policy versioning. Individual phases must not invent competing tier rules.

> **Deferred:** PostHog is intentionally not part of Part B. Add product analytics only after the UI/marketing/product surface exists and funnels, adoption, experiments, and user journeys become useful.

> **Architecture rule:** authentication, authorization, rate limiting, quota, observability, durable state, and transcript caching are separate concerns. Datadog is not the source of truth for security or usage. Redis is not the durable database. Postgres is not a cache merely because transcripts are valuable.

> **E2E rule:** GitHub E2E may start isolated Docker services such as Redis, Postgres, Datadog-compatible telemetry collectors/stubs, and other dependencies required for realistic integration tests. Test services/data are disposable and must not become production architecture.

## Phase 01 — Platform boundaries and request context

**Status:** `[ ]` not started.

**Build:** Define a canonical request context containing request ID, authentication principal, project/key identity, effective tier, entitlement snapshot, rate-limit identity, and trace/observability context. Establish the common request pipeline:

`request → validation → authentication → authorization → rate limit → quota → service → upstream/cache → accounting → observability → response`

Provider-specific code belongs behind stable internal interfaces such as `src/lib/auth`, `src/lib/rate-limit`, `src/lib/usage`, `src/lib/observability`, and `src/lib/product`.

Define configuration validation and dependency failure policy before implementation. Security-critical configuration must fail safely; optional observability must not take the API down.

**Test:** Run existing Part A E2E/regression tests and verify successful responses are byte/shape compatible. Add a request-context unit test proving every protected request gets a request ID and typed context. Remove one optional Datadog variable and confirm the API still serves. Remove a required auth secret in a test environment and confirm startup/runtime fails safely rather than silently disabling protection.

**Exit:** Shared context exists without duplicating provider logic.

## Phase 02 — Clerk user authentication

**Status:** `[ ]` not started.

**Build:** Integrate the current Clerk Next.js SDK using the repository's Next.js 16 App Router conventions and `proxy.ts` where appropriate. Add sign-in, sign-up, sign-out, and account flows required by the developer product. Normalize Clerk users into an internal `AuthContext`. Decide which REST routes are anonymous, authenticated, or machine-authenticated.

Do not expose Clerk server secrets to client code. Protected API routes must return machine-readable API errors rather than accidentally returning browser redirects.

**Test:** Use an authenticated test user to call a protected endpoint; call the same endpoint without a session; call public endpoints signed out. Verify correct 2xx vs 401 behavior and that no Clerk secret appears in browser bundles or responses.

**Exit:** User identity is reliably available server-side and protected routes enforce authentication.

## Phase 03 — Clerk tier metadata and session projection

**Status:** `[ ]` not started.

**Build:** Implement the tier model from [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md): all new users default to `free`; reserved future tiers include `pro`, `team`, and `enterprise`. Store authoritative tier state in Clerk user `publicMetadata`, and project only a small `tubelens.tier` claim into the Clerk session token. Treat the session claim as a fast projection, not the ultimate authority, because session claims can be temporarily stale between refreshes.

Implement safe fallback to `free` for missing/invalid tier values and keep custom session claims small.

**Test:** Create a user and verify default `free`. Update authoritative metadata and verify the API eventually sees the new tier. Test a stale session token and confirm security-sensitive entitlement checks use authoritative state or a documented refresh path. Inject an invalid tier and confirm it cannot become an elevated plan.

**Exit:** Tier cannot be self-escalated and the same effective-tier logic is reusable by REST and future MCP.

## Phase 04 — Tier administration endpoint

**Status:** `[ ]` not started.

**Build:** Add the planned admin-only `PATCH /api/v1/admin/users/:userId/tier` contract. Accept only known tier values, require authenticated admin capability, validate the target Clerk user ID, and reject client-controlled role/admin escalation. Update Clerk metadata through the supported metadata API and emit an audit event with actor, target, old tier, new tier, timestamp, request ID, and reason/source.

**Test:** Admin changes `free → pro` successfully. Normal user receives 403. User attempts to submit an admin role flag or modify another authorization field and is denied. Invalid tier receives 400. Verify audit event is emitted. Verify old/new tier values are sanitized and no secrets are recorded.

**Exit:** Tier manipulation is controlled, auditable, and never self-service unless a later product policy explicitly allows it.

## Phase 05 — Machine authentication with Clerk API Keys

**Status:** `[ ]` not started.

**Build:** Prefer Clerk API Keys as the credential authority for scripts, servers, and future MCP clients. TubeLens stores metadata only: Clerk key reference, owner, project/environment/label, plan binding if needed, created time, last-used time, and status. **Never store plaintext API-key secrets in Postgres.** Do not invent a parallel key vault unless a concrete Clerk limitation is documented.

Support API-key authentication independently from browser sessions and ensure the same internal principal model is used by both.

**Test:** Create a test API key through the supported Clerk flow, call a protected endpoint using the machine credential, call without it, and call with malformed credentials. Verify successful machine authentication has no browser dependency and the raw secret does not appear in logs, traces, responses, database rows, or test artifacts.

**Exit:** Machine authentication works without weakening user-session security.

## Phase 06 — Credential revocation and rotation

**Status:** `[ ]` not started.

**Build:** Wire revocation/rotation through the authoritative credential provider. Define propagation expectations and ensure revoked credentials cannot continue to access resources beyond the documented window. Track last-used metadata without recording the secret.

**Test:** Create key → request succeeds → revoke key → request fails with 401/403 according to the API contract. Rotate/reissue → new key works → old key fails. Test concurrent requests around revocation and verify there is no indefinite cached authorization decision.

**Exit:** Credential lifecycle is safe and operationally controllable.

## Phase 07 — Authorization and resource ownership

**Status:** `[ ]` not started.

**Build:** Create an explicit authorization matrix for anonymous users, authenticated users, API-key principals, projects, organizations/roles, admins, and future write scopes. Enforce authorization at the resource/service boundary, not only in UI code. Every resource lookup must be scoped to the caller's permitted owner/project/org.

**Test:** Create resources for User A and User B. Attempt cross-user access with User A; verify denial. Attempt access with a valid credential belonging to another project; verify denial. Test admin access separately. Verify UI hiding is irrelevant because direct HTTP requests still hit authorization checks.

**Exit:** Horizontal and vertical privilege boundaries are enforced server-side.

## Phase 08 — Input schema and request-size validation

**Status:** `[ ]` not started.

**Build:** Standardize Zod/request schema validation before business logic. Bound query lengths, pagination, limits, batch sizes, URL lengths, numeric ranges, enum values, request bodies, and any user-controlled filtering. Normalize input once and pass validated types downstream. Reject malformed payloads before expensive work or upstream calls.

**Test:** Send missing fields, unknown enums, negative numbers, giant limits, very long strings, malformed JSON, oversized bodies, and huge batch arrays. Verify deterministic 400/413-style errors according to the API contract, no upstream call occurs for rejected input, and CPU/memory usage remains bounded under repeated invalid traffic.

**Exit:** Untrusted input cannot bypass route assumptions or trigger unbounded work.

## Phase 09 — HTTP and security-header hardening

**Status:** `[ ]` not started.

**Build:** Establish deliberate API HTTP behavior for content types, HSTS where appropriate for production, `X-Content-Type-Options`, cache controls, CORS, and other applicable security headers. Avoid permissive wildcard CORS for authenticated browser flows unless explicitly justified. Ensure API endpoints do not accidentally render framework HTML error pages.

**Test:** Inspect representative success/error responses for expected headers. Test disallowed origins and approved origins. Send browser-like preflight requests. Verify protected JSON endpoints remain machine-readable on errors and that security headers survive 4xx/5xx responses.

**Exit:** HTTP behavior is predictable and hardened.

## Phase 10 — SSRF and outbound-request boundary

**Status:** `[ ]` not started.

**Build:** Audit every feature that accepts or constructs URLs. For arbitrary user-supplied URLs, apply strict allowlisting/validation and block loopback, private, link-local, metadata-service, and other internal destinations where applicable. Prefer fixed upstream hostnames for TubeLens-owned integrations. Put outbound requests behind one safe client abstraction with timeout and redirect rules.

**Test:** Attempt outbound requests to loopback, private RFC1918 ranges, link-local/metadata endpoints, localhost aliases, unusual IP encodings, and malicious redirects. Verify they are rejected before network access. Test allowed YouTube/provider URLs and normal redirects. Confirm blocked destinations never appear as successful upstream calls in Datadog.

**Exit:** TubeLens cannot casually become an SSRF proxy.

## Phase 11 — Secret management and secret-leak prevention

**Status:** `[ ]` not started.

**Build:** Inventory all credentials and keep them in deployment/environment secret storage. Add automated secret scanning to CI. Centralize redaction for `Authorization`, cookies, API keys, Clerk secrets, Redis credentials, database URLs, and similar values. Ensure errors and telemetry never serialize raw request headers or secret-bearing objects.

**Test:** Inject fake secrets into headers, request bodies, environment variables, and thrown errors; inspect logs, traces, test output, responses, and snapshots for exact-secret leakage. Run CI secret scanning against a fixture that intentionally resembles a secret and verify detection. Verify client bundles contain no server-only secret names/values.

**Exit:** Secret leakage is mechanically difficult, detectable, and tested.

## Phase 12 — Distributed Redis rate-limit engine

**Status:** `[ ]` not started.

**Build:** Use Upstash Redis for distributed enforcement across Vercel/serverless instances. Centralize policy in `src/lib/rate-limit`. Routes declare endpoint class/cost rather than implementing their own counters. Support dimensions such as anonymous IP, authenticated user, API key, project/org, and protected endpoint class. Start with burst + sustained controls using a sliding-window or token-bucket model where appropriate.

**Test:** Launch two application instances against the same Redis and send requests alternately; verify one shared limit is enforced. Repeat with different instances and processes. Verify a request cannot bypass a user/key limit by switching clients while retaining the same principal. Inspect `429` behavior under controlled bursts.

**Exit:** Rate limits are global to the logical principal, not local to a process.

## Phase 13 — Weighted-credit operation catalog

**Status:** `[ ]` not started.

**Build:** Implement the weighted-credit model. **Credit: Utkarsh's weighted-credit model idea** — TubeLens should meter API consumption with a common credit system where cheap and expensive operations consume different numbers of credits. Begin with policy defaults such as metadata/search `1`, comments `2`, transcript `3`, composed `4–5`, and batch = sum of protected child costs with a hard ceiling. Keep costs versioned so historical usage is never reinterpreted under today's price.

**Test:** Unit-test every endpoint's declared operation class and cost. Send cheap and expensive requests and verify different credit deductions. Change a policy version in a test environment and verify historical ledger rows retain the original version/cost. Attempt an unknown endpoint class and confirm it fails closed rather than silently becoming free.

**Exit:** Every billable/quotable operation has a deterministic, centrally defined cost.

## Phase 14 — Quota accounting and monthly allowance

**Status:** `[ ]` not started.

**Build:** Implement monthly/daily usage windows according to [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md). Track consumed weighted credits, allowance, remaining amount, reset time, account/user/project/key identity, tier, policy version, and accepted/rejected/partial outcome as appropriate. Keep durable accounting in Postgres only when the product requires it; Redis is the fast enforcement layer, not the historical source of truth.

**Test:** Start a test account with 10,000 monthly credits. Consume known costs and verify exact remaining balance. Drive usage to zero and verify the next charge is rejected. Move the clock across a reset boundary and verify a new window. Restart the application and verify durable usage remains correct when Postgres accounting is enabled.

**Exit:** Usage is deterministic, durable where required, and explainable.

## Phase 15 — Rate limit vs quota vs cache separation

**Status:** `[ ]` not started.

**Build:** Enforce the architecture distinction:

- **Rate limit:** can this principal make a request now? → Redis.
- **Quota/credits:** how much allowance has been consumed? → durable accounting when required, with Redis for fast checks.
- **Cache:** can an upstream fetch be avoided? → Part A CDN/in-memory by default.

Keep transcript caching out of Postgres unless a later explicit storage/cost/privacy decision enables it.

**Test:** Cache-hit request must still face rate-limit/quota rules. A cache miss must not bypass usage charging. Clearing the cache must not delete durable usage. Removing Postgres from a cache-only environment must not break Part A transcript functionality.

**Exit:** No subsystem is accidentally used as another subsystem's source of truth.

## Phase 16 — Batch protection and partial-abuse resistance

**Status:** `[ ]` not started.

**Build:** Define deterministic batch semantics: maximum child count, maximum total weighted cost, preflight vs incremental charging, partial-failure behavior, and response accounting. Prevent a batch from bypassing per-operation limits or turning one network call into unlimited upstream work.

**Test:** Submit valid batch within limits. Submit batch one item over the maximum. Submit batch with mixed cheap/expensive operations. Submit a batch whose calculated cost exceeds remaining credits. Retry the same batch and verify semantics are deterministic. Verify no hidden child calls occur after the batch is rejected.

**Exit:** Batch endpoints have explicit bounded economics and resource consumption.

## Phase 17 — Abuse controls and anomaly detection

**Status:** `[ ]` not started.

**Build:** Add configurable deny/block controls for obvious abuse: excessive failed authentication, credential spraying, repeated rejected requests, pathological batch patterns, or other high-confidence signals. Keep automatic blocking conservative and reversible. Store security decisions with enough context for operators without retaining unnecessary sensitive input.

**Test:** Simulate a threshold number of failed auth attempts and verify the documented response. Simulate abusive traffic from one key and verify only intended principals/dimensions are affected. Test block expiry/unblock. Confirm a normal developer workload near the boundary is not accidentally blocked.

**Exit:** Abuse controls reduce attack surface without becoming a blunt self-inflicted outage mechanism.

## Phase 18 — Datadog tracing foundation

**Status:** `[ ]` not started.

**Build:** Integrate Datadog's Node/Next.js tracing path using the current supported configuration. Trace important request, service, database, Redis, cache, and upstream operations where meaningful. Add service/environment/version tags and correlate spans through request/trace IDs. Keep instrumentation isolated from business logic.

**Test:** Make one representative API request and confirm a complete trace exists from route through important downstream work. Force an upstream failure and verify the trace contains the relevant error span. Verify sampling does not make essential operational signals impossible to inspect.

**Exit:** Operators can follow important requests through the service.

## Phase 19 — Structured logs and redaction

**Status:** `[ ]` not started.

**Build:** Standardize structured logs with request ID, route, status, latency, auth type, endpoint class, rate-limit result, cache result, upstream status, and safe error codes. Centralize redaction and use bounded attributes. Never log authorization headers, API-key values, session tokens, cookies, or raw secret-bearing payloads.

**Test:** Inspect logs for authenticated, API-key, rate-limited, invalid-input, and upstream-error requests. Search the resulting log stream for known fake secrets and headers. Verify every production log entry can be correlated by request ID without exposing user secrets.

**Exit:** Logs support debugging without becoming a credential database.

## Phase 20 — Metrics, dashboards, and SLO signals

**Status:** `[ ]` not started.

**Build:** Define metrics for request volume, p50/p95/p99 latency, 4xx/5xx rates, endpoint health, cache hit rate, upstream failure rate, Redis latency/errors, authentication failures, rate-limit rejections, quota exhaustion, weighted credit consumption, and deployment health. Build focused Datadog dashboards.

**Test:** Generate controlled traffic/errors and verify metric increments and dimensions are correct. Compare one endpoint against another. Deploy a deliberately isolated test regression and verify the relevant dashboard signal changes. Ensure high-cardinality raw identifiers are not used indiscriminately as metric labels.

**Exit:** Datadog answers what is happening without overwhelming itself with useless cardinality.

## Phase 21 — Reliability and dependency failure policies

**Status:** `[ ]` not started.

**Build:** Explicitly define failure behavior for Clerk, Redis, Postgres, Datadog, cache, and YouTube/provider dependencies. Security controls must not silently fail open. Datadog should generally degrade asynchronously. Decide which reads can use safe cached data and which operations must stop when a dependency is unavailable.

**Test:** Kill Redis during requests and verify documented rate-limit behavior. Disable Datadog delivery and verify API success paths continue. Restart Postgres and verify reconnect/recovery where used. Simulate Clerk verification failure and verify the API does not treat an unknown identity as trusted. Simulate YouTube timeout and verify bounded response behavior.

**Exit:** Dependency outages produce safe, predictable behavior instead of accidental security bypasses.

## Phase 22 — Timeouts, retries, and upstream protection

**Status:** `[ ]` not started.

**Build:** Put explicit deadlines around upstream and internal calls. Add retries only for operations that are safe and useful to retry; use bounded attempts and backoff. Avoid retry storms. Make cache behavior and stale-on-error policies explicit, preserving Part A transcript cache semantics.

**Test:** Use a test upstream that delays responses and verify request timeout. Force transient failures and verify only the allowed retry count. Measure total latency budget. Simulate concurrent failures and confirm retries do not multiply beyond the policy. Verify stale cache behavior remains within documented bounds.

**Exit:** TubeLens cannot hang indefinitely or amplify an upstream outage.

## Phase 23 — Idempotency and safe mutation foundation

**Status:** `[ ]` not started.

**Build:** Before shipping posting/write APIs, define idempotency requirements for operations where retries could duplicate side effects. Support an `Idempotency-Key` strategy where appropriate, bind keys to authenticated principal/resource/action, set retention/expiry, and ensure conflicting reuse is rejected. Keep browser-authenticated mutations protected against CSRF/origin abuse where relevant.

**Test:** Send the same mutation twice with the same idempotency key and verify one effect. Reuse the same key with a different payload and verify a deterministic conflict. Send two concurrent identical requests and verify only one side effect. Test expiry and then verify a new operation can use a new key.

**Exit:** Future writes have a defined retry-safety model before they become production features.

## Phase 24 — Audit event system

**Status:** `[ ]` not started.

**Build:** Implement the audit model from [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md) for security-sensitive events: key lifecycle, tier changes, project/security changes, privileged actions, abuse blocks, credit adjustments, and future posting/mutations. Store actor, action, resource, timestamp, request ID, sanitized before/after values, and reason/source. Do not permanently audit every high-volume normal read.

**Test:** Trigger each audit-worthy action and verify one durable event with correct actor/resource/request correlation. Verify normal API reads do not create unbounded security-audit rows. Attempt to place a fake secret into an auditable field and confirm sanitization. Verify audit records survive application restart.

**Exit:** Important security history is durable and queryable without turning the audit table into an API access log.

## Phase 25 — Developer plan/usage API

**Status:** `[ ]` not started.

**Build:** Implement `GET /api/v1/me/plan` according to [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md). Return effective tier/status, allowance/window, current usage, remaining credits, rate-limit summary, reset time, and policy version. Keep this response stable and independent of Datadog internals.

**Test:** Call as signed-out user, authenticated Free user, and a test Pro user. Verify correct authorization. Consume credits and confirm the remaining amount changes exactly. Change plan policy in a test version and verify the returned policy version changes while historical usage remains interpretable.

**Exit:** Developers can understand their current product limits through the API itself.

## Phase 26 — Developer security controls and dashboard integration

**Status:** `[ ]` not started.

**Build:** Add developer-facing controls for API-key lifecycle, plan/usage visibility, recent usage summary, security notices, and understandable rate-limit/quota errors. Require fresh authentication for especially sensitive account actions where appropriate. Keep operator-only Datadog separate from developer-facing metrics.

**Test:** Complete the flow entirely from the UI and direct API: sign in → create key → call API → see usage → hit a rate limit → revoke key → verify access stops. Attempt the same controls directly over HTTP with missing/incorrect authorization and verify backend enforcement.

**Exit:** Product controls are usable without weakening the actual API security boundary.

## Phase 27 — Supply-chain and CI security

**Status:** `[ ]` not started.

**Build:** Add dependency vulnerability checks, lockfile review, secret scanning, and security-sensitive CI checks. Pin/lock dependencies appropriately. Review new packages for necessity and scope. Keep production and test dependencies separated where practical.

**Test:** Introduce a deliberately vulnerable test dependency in a branch and verify CI flags it. Introduce a fake secret fixture and verify secret scanning fails. Verify lockfile-only changes are visible in review. Remove/upgrade the test package and verify CI returns green.

**Exit:** Repository changes are continuously checked for common supply-chain and credential mistakes.

## Phase 28 — Adversarial security E2E suite

**Status:** `[ ]` not started.

**Build:** Extend the GitHub E2E agent's responsibilities from functional regression into adversarial API testing. It may start isolated Redis, Postgres, telemetry stubs/collectors, and supporting services in Docker. Tests must not modify product code/config to make themselves pass.

Mandatory scenarios include: missing auth, malformed credentials, expired/revoked key, forged tier, unauthorized project access, oversized request, huge pagination, pathological batch, rapid burst, sustained abuse, concurrent quota consumption, Redis outage, Postgres restart, Datadog outage, upstream timeout, retry behavior, idempotency replay, audit emission, and secret leakage checks.

**Test:** Every scenario must assert both the HTTP contract and side effects: no unauthorized database access, no hidden upstream work, correct credit deductions, expected Redis state, correct audit entries where applicable, and safe telemetry. Run the suite against at least two application processes sharing the same Redis.

**Exit:** Security behavior is executable and regression-tested, not merely documented.

## Phase 29 — Production-readiness, rollback, and incident procedures

**Status:** `[ ]` not started.

**Build:** Document operational procedures for credential revocation, abuse blocks, tier correction, quota-policy rollback, Redis/Postgres recovery, Datadog investigation, deployment rollback, and incident escalation. Define retention/backup expectations for durable product data. Validate migrations and policy changes are reversible or safely forward-only by design.

**Test:** Conduct tabletop or automated drills: revoke a compromised key; roll back a bad quota policy; restart Redis; restore/reconnect Postgres; roll back a deployment; inspect a Datadog incident using request IDs. Record exact operator steps and verify they work without manual database surgery wherever a supported control exists.

**Exit:** The service can be operated safely during an incident, not only during normal traffic.

## Phase 30 — Final integration and production security gate

**Status:** `[ ]` not started.

**Goal:** prove the complete Part B platform as one coherent system before depending on it from Part C MCP.

**Mandatory acceptance matrix:**
- Clerk user authentication works.
- Default tier is Free and cannot be self-escalated.
- Admin tier mutation is authenticated, authorized, auditable, and reflected in effective entitlements.
- Clerk API Keys authenticate machines without storing plaintext secrets.
- Cross-user/project authorization is blocked.
- Input limits and HTTP hardening are enforced.
- SSRF defenses block internal destinations where arbitrary URLs exist.
- Distributed Redis rate limits work across multiple app instances.
- Weighted-credit costs are centrally defined and deterministic.
- Monthly quota accounting survives restarts and does not rely on transcript cache storage.
- Batch requests cannot bypass per-operation or total-cost controls.
- Abuse controls are bounded and reversible.
- Datadog traces/logs/metrics are visible for important paths without credential leakage.
- Datadog outage does not break normal API success paths.
- Redis/Clerk/Postgres failures follow documented safe policies.
- Upstream timeouts/retries stay within bounded budgets.
- Future mutation operations have idempotency/CSRF/origin requirements defined.
- Security-sensitive events have durable audit records.
- `/api/v1/me/plan` reports coherent effective limits.
- CI checks dependencies and secrets.
- Adversarial E2E passes with isolated Redis/Postgres/telemetry services.
- Existing Part A REST regression suite remains green.
- Documentation covers authentication, API keys, authorization, rate limits, quotas, credits, errors, operational expectations, and incident procedures.

**Definition of done:** TubeLens has a production-minded secure API platform: identity and machine authentication are controlled by Clerk; authorization is enforced at resource boundaries; distributed rate limits and weighted credits control consumption; durable product state is kept in Postgres only where genuinely necessary; Part A transcript caching stays CDN/in-memory by default; Datadog provides actionable backend observability; secrets and internal network access are protected; security events are auditable; failure modes are explicit; and a repeatable adversarial E2E suite proves the controls before Part C MCP inherits them.