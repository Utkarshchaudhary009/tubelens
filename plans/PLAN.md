# TubeLens API Roadmap

API-first backend: **Next.js Route Handlers + youtubei.ts on Vercel**.
All endpoints live under `/api/v1` (see `DX_PRINCIPLES.md` for conventions).
No frontend work is tracked here — each phase ships backend endpoints only.

> **ZERO-COST constraint ($0 spend):** Phases 1–7 run on **CDN + in-memory only**
> (Vercel free-tier `Cache-Control: s-maxage` + route-level `Map`/LRU, no paid
> infra). Free-tier durable stores (Upstash Redis, Cloudflare R2, Neon Postgres
> free tiers) are allowed **only when a phase absolutely requires it**, and are
> marked `OPTIONAL` at that phase — never a default. See `CACHING.md` (ladder +
> TTLs) and `NEED_TO_THINK.md` (risk gates) before adding any durable dependency.

> **Phase ordering = easy-go first, hard/risky later:** Phases 1–7 are cheap
> read-through Innertube calls; Phase 8+ (third-party crowd-sourced), Phase 9
> (audio/proxy + legal), and Phase 10 (batch/quota/ops) are deliberately last —
> do not pull them forward without clearing their `NEED_TO_THINK.md` gate.

> Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.
> Update the checkbox and `Status` line as phases land.

Total: **37 endpoints across 10 phases** (`openapi.json` stub lands in Phase 1,
completed in Phase 10 — counted once). (`trending` deferred out of Phase 3 on
2026-09-08 — see Phase 3 plan note; was 38.)

---

## Route vs filter rule (dedup)

Prefer a `?type=` / `?kind=` filter on the general route; keep a dedicated
route only when the backend source or shape genuinely differs.

- `search?type=music` wins for music-flavored queries; use
  `music/search` only when you need YouTube Music–native typing
  (song vs album vs artist) and charts-backed ranking.
- `playlists/:id?type=mix` wins for reading a generated mix; `mixes/:id`
  exists only as a lookup entry point (seed → mix id), then read via playlists.
- `channels/:id/streams` wins for one channel's live state; `feed/live`
  is the cross-channel discovery surface (viewer counts, scheduled times).
- `playlists/:id` returns metadata + first items page (cheap single call);
  use `playlists/:id/items` for pages 2+ and background refresh.

---

## Phase 1 — Core validation (5 endpoints)

**Goal:** Prove the product thesis with the smallest useful API: find anything,
read anything, resolve any URL, and report service health.

**Status:** `[x]` done — shipped via PR #4 (merged 2026-09-08): health, search, videos/:id, resolve, openapi.json live with 143 unit tests + e2e PASS on live upstream. Note: 7-day production health/p95 tail validation runs post-merge before Phase 2 closes out.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/health` | Liveness + youtubei.ts session status for uptime checks |
| GET | `/api/v1/search` | Unified search across videos, channels, and playlists |
| GET | `/api/v1/videos/:id` | Canonical video detail and metadata |
| GET | `/api/v1/resolve` | Resolve any YouTube URL to `{ type, id }` |
| GET | `/api/v1/openapi.json` | Spec stub: lists shipped endpoints, grows each phase |

**Exit criteria / validate before Phase 2:**
- `search` returns relevant results for 10 diverse probe queries (music, tech, non-English).
- `videos/:id` matches official metadata (title, channel, duration) on 20 sampled videos.
- `resolve` correctly classifies video / channel / playlist / short / live URLs (20 fixtures).
- `openapi.json` stub lints clean and documents every Phase 1 endpoint.
- `health` is green for 7 consecutive days on Vercel; p95 latency for `search` < 2s.

---

## Phase 2 — Watch essentials (4 endpoints)

**Goal:** Power a complete watch page backend: what to watch next, what people
say, and what is spoken.

**Status:** `[x]` done — shipped via PR #5 (merged 2026-09-08): related, comments, captions, transcript live with 207 unit tests + e2e PASS on live upstream.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/videos/:id/related` | Up-next / related videos rail |
| GET | `/api/v1/videos/:id/comments` | Top-level comments with continuation pagination |
| GET | `/api/v1/videos/:id/captions` | List available caption tracks and languages — aggressive-cache (see below) |
| GET | `/api/v1/videos/:id/transcript` | Timed transcript text for reading and search — **aggressive-cache: `s-maxage=86400` + SWR; future OPTIONAL persist (Neon/R2/Upstash free tier)** |

> **Transcript strategy (high-risk — YouTube hardens access):** `captions` and
> `transcript` are never live-only. Serve CDN-cached first, revalidate in
> background, and **serve stale-on-error** when upstream fails. A future phase
> may add OPTIONAL free-tier DB persist (Neon free / Upstash free / R2 free
> tier) — not before its gate in `NEED_TO_THINK.md`. TTLs in `CACHING.md`.

> **Transcript provider registry (dictionary-driven — adding a provider is one
> dict entry, no route edits):** the route chains the ordered
> `TRANSCRIPT_PROVIDERS` dict below (Innertube fast path first, then the
> `youtube-cli` `doc/plan.md:28-35` waterfall). Each entry declares everything
> the generic runner needs — request, parse mapping, lang handling, budget,
> key, and kill switch — so a new source never touches
> `videos/[id]/transcript/route.ts`.

> | # | name (warning tag) | kind | request | parse → `TranscriptSegmentDTO[]` | lang handling | key / enabled |
> | - | ------------------ | ---- | ------- | -------------------------------- | ------------- | ------------- |
> | 0 | `innertube` (fast path, absent tag) | native | `getInfo(id).getTranscript()` via singleton | `mapTranscriptInfo()` | track-agnostic (no kind filter) | always on |
> | 1 | `yttools` | `json` | `GET https://yttools.co/api/transcript?url=<watch url>&lang=<lang>` | `{transcript: [{text, offset(ms), duration(ms), lang}]}` → ms/1000 round3 | strict: all-tagged-but-none-match = failure (fall through); untagged kept, malformed non-string dropped | always on |
> | 2 | `youtube-transcript-ai` | `vtt` | `GET /api/subtitles?v=<id>` | tracks `{vttContent/vttUrl/json3Url}` → VTT/json3 parse | best-effort: requested track, else first available | always on |
> | 3 | `kome` | `text` | `POST /api/transcript {video_id: <full url>, format: true}` + `origin: https://kome.ai` | `{transcript: \"<plain text>\"}` → single zero-timestamp segment (dedupe); apology text rejected, never emitted | language-agnostic plain text | always on |
> | 4 | `supadata` | `json` | `GET /v1/youtube/transcript?url=...` + `x-api-key: $SUPADATA_API_KEY` (Whisper fallback for caption-less videos) | provider JSON → shared normalize | best-effort | `apiKeyEnv: \"SUPADATA_API_KEY\"`; skipped when unset |

> ```ts
> type TranscriptProviderKind = \"native\" | \"json\" | \"vtt\" | \"text\";
> interface TranscriptProviderDef {
>   name: string;                    // stable id, surfaced in `fallback_source` warning
>   kind: TranscriptProviderKind;    // which shared parser runs (native fast path | json path | VTT/json3 | plain text)
>   method: \"GET\" | \"POST\";
>   url: (id: string, lang: string) => string;
>   params?: (id: string, lang: string) => Record<string, string>;
>   body?: (id: string, lang: string) => unknown;
>   headers?: Record<string, string> | ((id: string) => Record<string, string>);
>   parse: { segmentsPath?: string; textField: string; offsetField: string; durationField: string };
>   lang: \"strict\" | \"best-effort\";  // strict = mismatch fails over; best-effort = first available
>   timeoutMs: number;               // per-provider cap, clamped to remaining overall budget
>   apiKeyEnv?: string;              // when set, entry is skipped if `process.env[apiKeyEnv]` is unset
>   enabled: boolean;                // per-provider kill switch, no route edit to flip
> }
> const TRANSCRIPT_PROVIDERS: TranscriptProviderDef[] = [ /* one entry per table row above */ ];
> ```

> - **Ordering / fallback chaining:** array order is chain order
>   (`innertube → yttools → youtube-transcript-ai → kome → supadata`); first
>   non-empty success wins; empty / language-mismatch / apology-text counts as
>   failure and falls through to the next enabled entry; disabled or
>   key-missing entries are skipped silently.
> - **Timeouts (remaining-budget):** one overall 8s fail-fast budget
>   (`AbortSignal.timeout(8000)`, route checklist) wraps fast-path + chain
>   combined — never stacked per-step budgets; each provider runs with
>   `min(timeoutMs, remainingMs)` and fails fast/independently.
> - **Shared helpers:** `normalizeSegments()` (ms→s round3, drop empty text /
>   negative offsets, plain-text → zero-timestamp deduped segment) and
>   `filterByLang()` (case/`_`/`-`-insensitive prefix match; untagged/blank
>   kept, malformed non-string dropped) run for every `json`/`vtt` entry.
> - **Typed errors:** `video_not_found` only on video-scoped wording
>   (`video … private|deleted|removed|unavailable|not found` or reverse) —
>   short-circuits the chain and must NOT serve stale; bare provider 4xx is
>   transcript-scoped (`transcript_unavailable`); timeouts/429s/5xx are
>   transient (stale-eligible). Mapped via `classifyTranscriptError()`, never a
>   bare 500 — cold-miss failures return a `code` + one-sentence `hint`.
> - **Cache key + attribution:** key `transcript:v1:{id}:{lang}` (lang is part
>   of the key); provider persists in the cached value
>   (`{segments, provider?}`) so hits/joins keep `warnings:
>   [{code: \"fallback_source\", message: \"… via ${provider}\"}]` (plus
>   `stale_served` when stale); absent provider = Innertube fast path.
> - **Tests:** one fixture test per provider (response → normalize → lang
>   filter), plus a contract test (every def has
>   name/kind/method/url/parse/lang/timeoutMs/enabled; new entry needs no
>   route edit) and waterfall tests (order, fallback on failure, disabled /
>   key-unset skip, `video_not_found` short-circuit, kome apology rejection).
> - **Caching TTLs (unchanged):** aggressive per `CACHING.md` —
>   `s-maxage=86400` + SWR `86400`, L0 fresh 24h + stale 24h,
>   cache-first + serve-stale-on-error, never live-only; empty results throw
>   so they never populate the cache.
> - **Envelope/headers (unchanged):** `{data, page: {next: null}, meta,
>   warnings}` per `DX_PRINCIPLES.md`; `X-Request-Id` (+ `meta.requestId`) and
>   `X-RateLimit-*` on every response; 429s carry `Retry-After` +
>   `code: rate_limited`.

**Exit criteria / validate before Phase 3:**
- Watch-page demo renders related + comments + transcript from API alone.
- `transcript` succeeds on videos with auto-captions and returns a clear
  `hint` error where captions are disabled.
- Comment pagination walks ≥ 5 pages without duplicates or drops.
- `transcript`/`captions` **serve stale-on-error** (upstream 403/429 still
  returns cached body with `meta.cached: true` + `warnings`); cold-miss failure
  returns a typed `hint`, never a bare 500. No live-only path ships.

---

## Phase 3 — Discovery (2 endpoints)

**Goal:** Answer \"what's popular and what did you mean\" beyond raw search.

**Status:** `[x]` done — shipped via PR #6 (merged 2026-09-09): search/suggestions + hashtags/:tag live with 241 unit tests + e2e PASS on live upstream (prod build). (`trending` deferred per plan note — no viable $0 upstream.)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/search/suggestions` | Autocomplete suggestions for a partial query |
| GET | `/api/v1/hashtags/:tag` | Video feed for a hashtag |

> **Plan note (2026-09-08, verified live):** `GET /trending` is **deferred** —
> its upstream no longer exists. YouTube removed the Trending tab/feed (2025);
> youtubei.js dropped `getTrending` in v17 (`#1114`); raw browses of
> `FEtrending` / `FEexplore` return HTTP 400; and logged-out `getHomeFeed()`
> returns only a sign-in nudge (no videos) across WEB/ANDROID/TVHTML5 sessions.
> Shipping `/trending` on any of these would serve empty or fabricated data.
> It returns to the roadmap only when a $0-viable popular-feed source exists
> (candidates: Phase 6 charts or Phase 7 vertical feeds). The remaining
> Phase 3 exit criteria below are unchanged and verifiable.

**Exit criteria / validate before Phase 4:**
- `suggestions` p95 latency < 500ms (cacheable, short TTL).
- Hashtag feed returns non-empty results for 10 sampled real-world tags.

---

## Phase 4 — Channels (4 endpoints)

**Goal:** Full channel profiles and their content surfaces.

**Status:** `[x]` done — shipped via PR #7 (merged 2026-09-09): channels/:id profile + videos/shorts/streams feeds live with 286 unit tests + e2e PASS on live upstream.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/channels/:id` | Channel profile, stats, and about info |
| GET | `/api/v1/channels/:id/videos` | Channel uploads (latest videos) |
| GET | `/api/v1/channels/:id/shorts` | Channel Shorts shelf |
| GET | `/api/v1/channels/:id/streams` | Live, upcoming, and past streams |

**Exit criteria / validate before Phase 5:**
- 20 sampled channels show correct handles, avatars, and subscriber counts.
- Uploads / shorts / streams each paginate cleanly with no type leakage
  (e.g. no long-form videos inside `shorts`).

---

## Phase 5 — Playlists (3 endpoints)

**Goal:** Read any playlist and list a channel's curated collections.

**Status:** `[x]` done — shipped via PR #8 (merged 2026-09-09): playlists/:id profile + items pagination + channels/:id/playlists live with 340 unit tests + e2e PASS on live upstream.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/playlists/:id` | Playlist metadata plus first page of items |
| GET | `/api/v1/playlists/:id/items` | Paginated playlist items |
| GET | `/api/v1/channels/:id/playlists` | Playlists created by a channel |

**Exit criteria / validate before Phase 6:**
- 100+ item playlists paginate end-to-end with stable ordering.
- Private / deleted videos inside playlists degrade to typed placeholders,
  never 500s.

---

## Phase 6 — Music (3 endpoints)

**Goal:** Music-scoped discovery and artist pages.

**Status:** `[x]` done — shipped via PR #9 (merged 2026-09-09): music/search + music/charts + artists/:id live with 369 unit tests + e2e PASS on live upstream (prod build). Note: `country` is echo-only with `country_fallback` warning for non-US (per-country charts need the YTMusic menu-feedback flow); charts snapshot verified live for the default US region.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/music/search` | Music-native search (songs, albums, artists); else prefer `search?type=music` |
| GET | `/api/v1/music/charts` | Charts for top songs, videos, and artists by country |
| GET | `/api/v1/artists/:id` | Artist profile with top releases |

**Exit criteria / validate before Phase 7:**
- Music search results are correctly typed (song vs album vs artist).
- Charts match YouTube Music charts for 2 countries on the same day.

---

## Phase 7 — Explore verticals (3 endpoints)

**Goal:** Cover the three highest-traffic vertical feeds.

**Status:** `[x]` done — shipped via PR #10 (merged 2026-09-09): feed/shorts + feed/live + feed/gaming live with 407 unit tests + e2e PASS on live upstream (prod build). All three search-backed (no native v18 feed methods; gaming browse resolves to a topic channel with no servable tabs logged-out). Note: gaming returns video discovery (no dedicated live filter); `country`/`region` echo-only.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/feed/shorts` | Shorts discovery feed |
| GET | `/api/v1/feed/live` | Cross-channel live discovery (per-channel state via `channels/:id/streams`) |
| GET | `/api/v1/feed/gaming` | Gaming hub videos and live streams |

**Exit criteria / validate before Phase 8:**
- Each feed returns fresh (non-stale) items on repeat calls.
- `feed/live` items all carry live viewer counts or scheduled times.

---

## Phase 8 — Community-enriched data (4 endpoints, OPTIONAL durable cache)

**Goal:** The \"composed killers\": crowd-sourced layers no official API offers,
plus one combined call that makes the frontend trivial. Durable persist
(Upstash/R2 free tier) is OPTIONAL here only — default stays CDN + in-memory.

**Status:** `[x]` done — shipped via PR #11 (merged 2026-09-10): sponsors + dislikes + dearrow + combined live with 450 unit tests + e2e PASS on live upstream. CDN + in-memory only, no durable store. Production deployment green at main head; direct prod curl blocked by Vercel SSO Deployment Protection (needs owner bypass to re-verify).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/videos/:id/sponsors` | SponsorBlock segments (sponsor, intro, silence) |
| GET | `/api/v1/videos/:id/dislikes` | ReturnYouTubeDislike estimated dislike stats |
| GET | `/api/v1/videos/:id/dearrow` | DeArrow crowd-sourced titles and thumbnails |
| GET | `/api/v1/videos/:id/combined` | Single composed response: detail + sponsors + dislikes + dearrow |

**Exit criteria / validate before Phase 9:**
- Each third-party source degrades independently (one source down still
  returns partial data with a `warnings` array, never a 500).
- `combined` replaces ≥ 3 frontend round-trips in the demo client.

---

## Phase 9 — Audio-first (3 endpoints, flag-gated; no durable store by default)

**Goal:** Background listening and karaoke-style experiences. Stays behind a
feature flag until post-v1 legal review — see `NEED_TO_THINK.md`.

**Status:** `[x]` done — shipped via PR #12 (merged 2026-09-10): audio (signed-URL + Range-gateway, fail-closed without secret, per-video kill switch) + radio (dedupe queue, cursor paging) + lyrics (timed/plain, 404 lyrics_unavailable) live with 497 unit tests + e2e PASS on live upstream. All three behind `TUBELENS_AUDIO_ENABLED` (default OFF until post-v1 legal review); CDN + in-memory only, no durable store. Production deployment green at merge head; direct prod curl blocked by Vercel SSO Deployment Protection (needs owner bypass to re-verify).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/videos/:id/audio` | Range-gateway audio proxy, signed expiring URLs (flag-gated, post-v1) |
| GET | `/api/v1/videos/:id/radio` | Autoplay radio continuation from a seed video |
| GET | `/api/v1/videos/:id/lyrics` | Song lyrics where available |

> `audio` serves bytes via Range requests, never raw upstream URLs; links
> expire and the route stays behind a feature flag until post-v1 legal review.

**Exit criteria / validate before Phase 10:**
- `audio` plays uninterrupted for a full 10-minute video in the demo client.
- Takedown/abuse signals disable the proxy per-video within 1 hour and return
  a typed `hint` error (no silent breakage, no re-serve after takedown).
- `radio` generates a ≥ 25-track queue without repeats in the first 10.
- `lyrics` returns timed lines where the source provides them, plain text otherwise.

---

## Phase 10 — Utils and polish (7 endpoints)

**Goal:** Interop, performance, and self-description: everything that makes the
API pleasant to consume and operate.

**Status:** `[x]` done — shipped via PR #13 (merged 2026-09-10): channels/:id/rss + mixes/:id + thumbnails + instances + batch + quota live with 536 unit tests + e2e PASS on live upstream (prod build). openapi.json promoted to full 37-path spec.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/v1/channels/:id/rss` | Channel RSS feed for readers and webhooks |
| GET | `/api/v1/mixes/:id` | Seed → mix id lookup (read items via `playlists/:id`) |
| GET | `/api/v1/thumbnails` | Thumbnail resolver and proxy at requested quality |
| GET | `/api/v1/instances` | Peer instance status for failover-aware clients |
| POST | `/api/v1/batch` | Batch multiple resource reads in one round-trip |
| GET | `/api/v1/quota` | Current quota usage and rate-limit windows |
| GET | `/api/v1/openapi.json` | Full machine-readable spec (stub shipped in Phase 1) |

**Exit criteria / API v1 complete:**
- `openapi.json` validates with an OpenAPI linter and every shipped endpoint
  appears in it (stub promoted to full spec, no drift).
- `batch` handles 10 sub-requests with per-item error isolation.
- Public demo app runs exclusively on documented endpoints.

---
# TubeLens — Part B: Secure API Platform, Identity, Usage & Observability

Part B is the platform/security layer between the completed REST API (Part A) and the MCP layer (Part C).

**Goal:** turn TubeLens from a collection of working REST routes into a secure, observable, abuse-resistant developer API with user identity, machine authentication, authorization, distributed rate limiting, weighted-credit quotas, durable product state, operational visibility, and a safe foundation for future posting/mutations.

**Primary systems:**
- **Clerk** — user identity, sessions, API keys, and organizations/roles where needed, plus machine authentication.
- **Upstash Redis** — distributed rate limiting, short-lived counters, burst/sustained enforcement, and abuse controls.
- **Postgres** — durable product state only: plans, policy versions, durable usage/credit accounting, projects, audit events, and future posting-related state. **Postgres is not the default transcript cache.** Part A transcript caching remains CDN + in-memory by default.
- **Datadog** — backend observability: traces/APM, structured logs, metrics, error monitoring, service health, and alerts.
- **Vercel** — application/runtime deployment.

> **Foundation for later MCP (REST first):** Part B builds `src/lib/auth.ts` (`AuthContext`, `getEffectiveTier`, `requireAuth`/`requireAdmin`) and `src/lib/quota.ts` (operation → cost map) for REST handlers; MCP later reuses them as a thin wrapper (no loopback, no duplicate logic). Dual-auth coexists throughout: interactive browser sessions (`session_token`) plus non-interactive machine credentials (`api_key`, Phase 05); MCP user-OAuth via `@xmcp-dev/clerk` coexists with API keys. See `PLANS_AND_USAGE.md` §15–§16.

> **Canonical plans and usage source of truth:** [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md). It defines Free/default tier behavior, future tiers, Clerk tier claims, tier management, weighted credits, quota semantics, usage/audit data, and policy versioning. Individual phases must not invent competing tier rules.

> **Deferred:** PostHog is intentionally not part of Part B. Add product analytics only after the UI/marketing/product surface exists and funnels, adoption, experiments, and user journeys become useful.

> **Architecture rule:** authentication, authorization, rate limiting, quota, observability, durable state, and transcript caching are separate concerns. Datadog is not the source of truth for security or usage. Redis is not the durable database. Postgres is not a cache merely because transcripts are valuable.

> **E2E rule:** GitHub E2E may start isolated Docker services such as Redis, Postgres, Datadog-compatible telemetry collectors/stubs, and other dependencies required for realistic integration tests. Test services/data are disposable and must not become production architecture.

## Phase 00 — Neon Postgres infrastructure for future durable state

**Status:** `[x]` done — shipped via PR #19 (merged 2026-09-14): Neon/Drizzle plumbing (pooled `DATABASE_URL` + direct `DATABASE_DIRECT_URL`, server-only singleton, empty schema, `db:migrate`/`db:generate`) with 8s `SELECT 1` health check, credential-free generate, and 592 unit tests + e2e PASS on live upstream. Note: live `db:migrate` apply/rollback against a preview/dev branch still needs owner Neon credentials (tracked in `drizzle/README.md`).

**Build:** Create the Neon project with branch-per-env (`dev`/`preview`/`prod`) and wire pooled + direct connection strings via env vars (`DATABASE_URL` pooled, `DATABASE_DIRECT_URL` direct for migrations). Set up Drizzle ORM with `drizzle/` schema + migrations folder and a `db:migrate` script. Add a `src/lib/db/client.ts` singleton with `import "server-only"` on the Neon serverless driver for Vercel. Define the local-dev story (Neon `dev` branch or PGlite/proxy). Add a `SELECT 1` health-check query behind the 8s fail-fast budget. Keep transcript caching out of Postgres (CDN + in-memory default). Keep all URLs/secrets in env/Vercel envs only — no plaintext credentials in the repo.

**Test:** Run `db:migrate` against an isolated preview/dev branch and confirm a clean apply/rollback path. Import `src/lib/db/client.ts` from a server-only route test and confirm the `server-only` boundary holds. Hit the health-check with a forced timeout and verify bounded 8s failure. Verify local dev connects via the documented branch/proxy path. Verify no transcript table/migration exists and that secret scanning finds no database URL in the repo.

**Exit:** Later phases add tables/migrations without reworking connection, client, or env plumbing.

## Phase 01 — Platform boundaries and request context

**Status:** `[x]` done — shipped via PR #20 (merged 2026-09-14): request context + provider boundaries (auth/rate-limit/usage/observability/product) wired into health with Part A wire-contract byte-identical, 626 unit tests + e2e PASS on live upstream. Note: restores PR #17, whose commits were lost from main by a later history rewrite.

**Build:** Define a canonical request context containing request ID, authentication principal, project/key identity, effective tier, entitlement snapshot, rate-limit identity, and trace/observability context. Establish the common request pipeline:

`request → validation → authentication → authorization → rate limit → quota → service → upstream/cache → accounting → observability → response`

Provider-specific code belongs behind stable internal interfaces such as `src/lib/auth`, `src/lib/rate-limit`, `src/lib/usage`, `src/lib/observability`, and `src/lib/product`.

Define configuration validation and dependency failure policy before implementation. Security-critical configuration must fail safely; optional observability must not take the API down.

**Test:** Run existing Part A E2E/regression tests and verify successful responses are byte/shape compatible. Add a request-context unit test proving every protected request gets a request ID and typed context. Remove one optional Datadog variable and confirm the API still serves. Remove a required auth secret in a test environment and confirm startup/runtime fails safely rather than silently disabling protection.

**Exit:** Shared context exists without duplicating provider logic.

## Phase 02 — Clerk user authentication

**Status:** `[x]` done — shipped via PR #21 (merged 2026-09-14): Clerk user sessions behind the Phase 01 auth seam + protected `GET /api/v1/me` (typed 200/401 envelope, fail-safe, no secrets client-side) with 643 unit tests + e2e PASS on live upstream. Note: live authenticated-200 path covered by stub-provider unit tests (no Clerk test credentials in CI); sign-in/up/out UI is Clerk-hosted (API-only repo).

**Build:** Integrate the current Clerk Next.js SDK using the repository's Next.js 16 App Router conventions and `proxy.ts` where appropriate. Add sign-in, sign-up, sign-out, and account flows required by the developer product. Normalize Clerk users into an internal `AuthContext`. Decide which REST routes are anonymous, authenticated, or machine-authenticated.

Do not expose Clerk server secrets to client code. Protected API routes must return machine-readable API errors rather than accidentally returning browser redirects.

**Test:** Use an authenticated test user to call a protected endpoint; call the same endpoint without a session; call public endpoints signed out. Verify correct 2xx vs 401 behavior and that no Clerk secret appears in browser bundles or responses.

**Exit:** User identity is reliably available server-side and protected routes enforce authentication.

## Phase 03 — Clerk tier metadata and session projection

**Status:** `[x]` done — shipped via PR #22 (merged 2026-09-15): `getEffectiveTier()` claim projection (`tubelens.tier` → ranked tier, invalid/`team`/missing → `free`, never throws) wired through `clerkAuthProvider`/`contextFromClerkSession` into the request pipeline, typed via `CustomJwtSessionClaims`, with 658 unit tests + e2e PASS on live upstream. Note: live authenticated-claim path covered by stub-provider unit tests (no Clerk test credentials in CI); authoritative write-path re-fetch is Phase 04 scope.

**Build:** Implement the tier model from [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md): all new users default to `free`; ranked tiers are `free < plus < pro < enterprise` (`team` is an org concept, never a tier). Store authoritative tier state in Clerk user `publicMetadata`, and project only a small `tubelens.tier` claim into the Clerk session token. Treat the session claim as a fast projection, not the ultimate authority, because session claims can be temporarily stale between refreshes.

Implement safe fallback to `free` for missing/invalid tier values and keep custom session claims small.

**Test:** Create a user and verify default `free`. Update authoritative metadata and verify the API eventually sees the new tier. Test a stale session token and confirm security-sensitive entitlement checks use authoritative state or a documented refresh path. Inject an invalid tier and confirm it cannot become an elevated plan.

**Exit:** Tier cannot be self-escalated and the same effective-tier logic is reusable by REST and future MCP.

## Phase 04 — Tier administration endpoint (Part B)

**Status:** `[x]` done — shipped via PR #23 (merged 2026-09-15): admin-only `PATCH users/:userId/tier` + `users/:userId/role` with `requireAdmin` fast-reject + authoritative caller re-check, owned-key-only writes, timeout reconcile audit (`change_reconciled`), per-mutation audit rows, 699 unit tests + e2e PASS on live upstream.

**Canonical keys.** Authoritative state lives in Clerk user `publicMetadata` with exactly two keys: `tier: free|plus|pro|enterprise` (ranked `free < plus < pro < enterprise`; `team` is an org concept, not a tier) and `role: admin|support|user`. Backend-written, UI-readable. Never use `unsafeMetadata` for roles/tier; `privateMetadata` is reserved for future internal flags. Session token projects only the tier via the Clerk Dashboard (Sessions → Customize session token), e.g. `{ "metadata": "{{user.public_metadata}}", "tubelens": { "tier": "{{user.public_metadata.tier}}" } }`; keep custom claims under 1.2KB. Orgs are not used — `publicMetadata.role` is the admin signal.

**Bootstrap of first admin (no self-grant endpoint).** The first `admin` is created out-of-band via the Clerk Dashboard (Users → target user → Public metadata → `{ "role": "admin", "tier": "…" }`) or via `clerkClient.users.updateUserMetadata()`. Never ship an endpoint that lets a caller grant itself `admin`; every admin endpoint must reject self-escalation server-side.

**Shared helpers to build (in `src/lib/auth`, new file).** `AuthContext` (request ID, principal, effective tier, rate-limit identity) + `requireAuth()` (typed 401 when signed out) + `requireAdmin()` → resolves the caller via `auth()` + session claims, returns `{ userId, role }` on success or a typed 401-unauthenticated / 403-forbidden outcome the handler maps to `errorResponse()`; never use `auth.protect()` in Route Handlers (it throws 404). `getEffectiveTier()` → fast path reads the projected session claim (`sessionClaims.metadata.role` / `tubelens.tier` per `types/globals.d.ts CustomJwtSessionClaims`) with safe fallback to `free` on missing/invalid values; prefer `auth()` + claims on hot paths over `currentUser()`/`getUser()`, which cost a Backend API call. Enforce authorization inside the handler/service, never only in `proxy.ts` (`proxy.ts` is not a complete authZ boundary, cf CVE-2025-29927).

**Endpoints.** Two admin-only Route Handlers:

- `PATCH /api/v1/admin/users/:userId/tier` — body zod schema `{ tier: z.enum(["free","plus","pro","enterprise"]), reason: z.string().max(280).optional() }`.
- `PATCH /api/v1/admin/users/:userId/role` — body zod schema `{ role: z.enum(["admin","support","user"]), reason: z.string().max(280).optional() }`.

Path validation: `:userId` must match `/^user_[A-Za-z0-9]+$/`, else 400 `invalid_user_id`. Strip any extra body keys that smuggle `role`/`tier`/privilege fields (zod `.strict()` or explicit pick). Guards: unauthenticated → 401; non-admin → 403; self-demotion (`actor === target && role !== "admin"`) → 403; unknown tier → 400 `invalid_tier`; unknown role → 400 `invalid_role`.

**Contract (AGENTS.md route checklist).** `export const runtime = "nodejs"`; zod failures → 400 `{ error: { code, message, hint, status } }` via `errorResponse()`; success via `successResponse()` envelope `{ data, page: { next: null }, meta, warnings }`; `Cache-Control: private, no-store`; Clerk calls wrapped in an 8s fail-fast budget (`AbortSignal.timeout(8000)`); every response carries `X-Request-Id` (+ `meta.requestId`) and `X-RateLimit-*`.

**Write path (authoritative, not stale claims).** Claims lag ~60s, so the write path must re-fetch authoritative state: `clerkClient.users.getUser(targetId)` → record old `tier`/`role` → `clerkClient.users.updateUserMetadata(targetId, { publicMetadata: { … } })` (dedicated method wrapping `PATCH /v1/users/{userId}/metadata`; deep-merge, `null` removes; since API version 2026-05-12 metadata is rejected on general `updateUser()`). Emit one audit row per mutation: `actor / target / old / new / ts / requestId / reason`.

**Test matrix.** Unit: zod schemas accept/reject tier + role enums and over-long `reason`; `getEffectiveTier()` falls back to `free` on missing/invalid; self-demote guard blocks `actor === target && role !== "admin"`. Integration (mocked `clerkClient`): 200 happy path for each endpoint, 401 signed-out, 403 non-admin, 400 `invalid_tier` / `invalid_role` / `invalid_user_id`, audit row emitted with sanitized old/new and no secrets. Stale-claim test: session claim says old tier while `getUser()` returns new tier — write path uses authoritative value.

**Exit (autonomous-bot checklist):** both endpoints return 401/403/400/200 per matrix; no self-grant or self-demote path exists; audit row contains actor/target/old/new/ts/requestId/reason; `bun run lint`, `npx tsc --noEmit`, `bun test` pass.

**References:** see [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md) §2–§4 and the References subsection there for Clerk doc URLs.

**Test:** Admin changes `free → pro` successfully. Normal user receives 403. User attempts to submit an admin role flag or modify another authorization field and is denied. Invalid tier receives 400. Verify audit event is emitted. Verify old/new tier values are sanitized and no secrets are recorded.

**Exit:** Tier manipulation is controlled, auditable, and never self-service unless a later product policy explicitly allows it.

## Phase 05 — Clerk API keys for machine auth

**Status:** `[x]` done — shipped via PR #24 (merged 2026-09-15): admin-only `POST /api/v1/admin/keys` + `GET /api/v1/admin/keys?subject=` + `POST /api/v1/admin/keys/:keyId/revoke` with `ak_*` Bearer fallback in `clerkAuthProvider` (fail-closed revoked/expired/deleted-subject guards, API-key principals can never pass `requireAdmin`), authoritative `tierAtIssuance` binding with self-grant rejection, secret-once issuance, paged metadata-only listing (abort-aware walk, `truncated` warning past the 1000-key cap), per-mutation audit rows, 742 unit tests + e2e PASS on live upstream.

**Goal:** non-interactive machine authentication for scripts, cron, and
server-to-server callers — coexisting with interactive MCP user-OAuth
(`@xmcp-dev/clerk`), not replacing it.

**Keys vs user-OAuth (both coexist):**

| | Clerk API key (`ak_*`) | MCP user-OAuth (`@xmcp-dev/clerk`) |
|---|---|---|
| Flow | opaque secret, no login popup | interactive JWT via DCR + PKCE + consent |
| Caller | scripts / cron / servers | agentic clients acting as a user |
| Identity | tied to `subject` (`user_xxx`) | `getSession()` / `getUser()` |
| Scopes | key-level `scopes` / `claims` | user session scopes |
| Revoke | instant per-key revoke | session revoke |

Both resolve to the same Clerk user identity and bind the same ranked tier
(`free < plus < pro < enterprise`) through the shared `src/lib/auth.ts`
principal model.

**Build:**
- Enable User keys in the Clerk Dashboard. Clerk is the credential authority:
  `apiKeys.create({ name, subject, scopes, claims, secondsUntilExpiration })`
  (secret returned once, never stored), `apiKeys.verify(secret)`,
  `apiKeys.list({ subject, includeInvalid, limit, offset })`,
  `apiKeys.revoke({ apiKeyId, revocationReason })`. Metadata-only storage —
  $0-safe, no parallel vault.
- Three admin-only Route Handlers (`requireAdmin`, `export const runtime = "nodejs"`, zod bodies, 8s fail-fast, `Cache-Control: private, no-store`):
  - `POST /api/v1/admin/keys` — body `{ subject: user_xxx, name, scopes, secondsUntilExpiration, claims }`; binds `tierAtIssuance` from authoritative `getUser(subject)` metadata (never client-supplied); returns the secret once.
  - `GET /api/v1/admin/keys?subject=user_xxx` — lists key metadata (never secrets).
  - `POST /api/v1/admin/keys/:keyId/revoke` — body `{ revocationReason }`; rotation = create-new + revoke-old.
- Verification accepts both token types — `auth({ acceptsToken: ["session_token", "api_key"] })` (or `authenticateRequest`) — and switches on `tokenType`: key calls resolve `subject` → `getEffectiveTier()` with `free` fallback; key `scopes` map to operation costs via `src/lib/quota.ts`.
- Local metadata table `api_key_metadata` (`keyId, subject, name, scopes, tierAtIssuance, createdBy, createdAt, expiresAt, revoked, revocationReason, lastUsedAt`), no plaintext. MVP: Clerk is the source of truth + in-memory metadata; Postgres persist deferred until a durable need proves it.
- Audit every issuance / revocation / rotation per `PLANS_AND_USAGE.md` §10 (actor / target / keyId / old / new / ts / requestId / reason, sanitized, no secrets).

**Test matrix:** 200 happy path (issue → call a protected endpoint with `ak_*` → 200, no browser involved); 401 on missing / malformed / revoked secret; 403 non-admin on all three admin routes; 400 on `invalid_subject` / unknown scope / bad expiry; secret appears exactly once (creation response) and never in logs, traces, rows, or snapshots; key resolves the authoritative subject tier; revoke → 401 within 60s; rotation (new key works, old key fails).

**Exit:** 401/403/400/200 matrix green; no self-grant path (callers cannot mint keys bound above their own authoritative tier, and cannot grant themselves `admin`); revocation takes effect ≤ 60s; `bun run lint`, `npx tsc --noEmit`, `bun test` pass.

## Phase 06 — Credential revocation and rotation (merged into Phase 05)

> Folded into Phase 05: revocation (`POST /api/v1/admin/keys/:keyId/revoke`,
> `apiKeys.revoke`, ≤60s effect window) and rotation (create-new + revoke-old)
> ship with the API-key endpoints. Session revoke, tier downgrade, and ban
> flows additionally live in Phase 17. Kept as a numbered placeholder so phase
> numbering stays stable.

## Phase 07 — Authorization and resource ownership

**Status:** `[x]` done — shipped via PR #25 (merged 2026-09-15): explicit deny-by-default matrix (`src/lib/authorize.ts` — anonymous/user/api_key/support/admin + `requireOwnerOrAdmin`/`requireScope`), pipeline authorization stage, subject-scoped key list/revoke (foreign rows withheld, divergence → 409 `key_owner_mismatch`), authority-subject verification on issuance, key-scope projection, 795 unit tests + e2e PASS on live upstream.

**Build:** Create an explicit authorization matrix for anonymous users, authenticated users, API-key principals, projects, organizations/roles, admins, and future write scopes. Enforce authorization at the resource/service boundary, not only in UI code. Every resource lookup must be scoped to the caller's permitted owner/project/org.

**Test:** Create resources for User A and User B. Attempt cross-user access with User A; verify denial. Attempt access with a valid credential belonging to another project; verify denial. Test admin access separately. Verify UI hiding is irrelevant because direct HTTP requests still hit authorization checks.

**Exit:** Horizontal and vertical privilege boundaries are enforced server-side.

## Phase 08 — Input schema and request-size validation

**Status:** `[x]` done — shipped via PR #26 (merged 2026-09-16): centralized bounds in `validate.ts` (q 200, cursor 2048, url 4000, body 100KB streamed UTF-8 bytes with 413 on overrun) enforced before cache/upstream on every route, legacy limit-clamp/region-fallback/error shapes preserved, with 841 unit tests + e2e PASS on live upstream.

**Build:** Standardize Zod/request schema validation before business logic. Bound query lengths, pagination, limits, batch sizes, URL lengths, numeric ranges, enum values, request bodies, and any user-controlled filtering. Normalize input once and pass validated types downstream. Reject malformed payloads before expensive work or upstream calls.

**Test:** Send missing fields, unknown enums, negative numbers, giant limits, very long strings, malformed JSON, oversized bodies, and huge batch arrays. Verify deterministic 400/413-style errors according to the API contract, no upstream call occurs for rejected input, and CPU/memory usage remains bounded under repeated invalid traffic.

**Exit:** Untrusted input cannot bypass route assumptions or trigger unbounded work.

## Phase 09 — HTTP and security-header hardening

**Status:** `[x]` done — shipped via PR #27 (merged 2026-09-16): centralized security baseline (nosniff, DENY, no-referrer, Permissions-Policy, API CSP, HSTS) on every /api/v1 success/error/raw response, allowlist-only CORS via `TUBELENS_ALLOWED_ORIGINS` (never `*`, always `Vary: Origin`) with central OPTIONS preflight, typed JSON 404 `[[...notFound]]` catch-all, with 879 unit tests + e2e PASS on live upstream.

**Build:** Establish deliberate API HTTP behavior for content types, HSTS where appropriate for production, `X-Content-Type-Options`, cache controls, CORS, and other applicable security headers. Avoid permissive wildcard CORS for authenticated browser flows unless explicitly justified. Ensure API endpoints do not accidentally render framework HTML error pages.

**Test:** Inspect representative success/error responses for expected headers. Test disallowed origins and approved origins. Send browser-like preflight requests. Verify protected JSON endpoints remain machine-readable on errors and that security headers survive 4xx/5xx responses.

**Exit:** HTTP behavior is predictable and hardened.

## Phase 10 — SSRF and outbound-request boundary

**Status:** `[x]` done — shipped via PR #28 (merged 2026-09-16): `src/lib/safe-fetch.ts` boundary (https-only, allowlist pin, loopback/RFC1918/link-local/metadata blocks, decimal/octal/hex IP decoding, credentialed-URL rejection, default DNS pinning fail-closed, manual redirects re-validated per hop, 8s fail-fast) migrated across community/audio/transcript/batch/tunnel call sites, with 909 unit tests + e2e PASS on live upstream. Note: connection-level DNS-rebinding pinning documented as residual (global fetch has no lookup hook; all prod hostnames are fixed allowlist entries).

**Build:** Audit every feature that accepts or constructs URLs. For arbitrary user-supplied URLs, apply strict allowlisting/validation and block loopback, private, link-local, metadata-service, and other internal destinations where applicable. Prefer fixed upstream hostnames for TubeLens-owned integrations. Put outbound requests behind one safe client abstraction with timeout and redirect rules.

**Test:** Attempt outbound requests to loopback, private RFC1918 ranges, link-local/metadata endpoints, localhost aliases, unusual IP encodings, and malicious redirects. Verify they are rejected before network access. Test allowed YouTube/provider URLs and normal redirects. Confirm blocked destinations never appear as successful upstream calls in Datadog.

**Exit:** TubeLens cannot casually become an SSRF proxy.

## Phase 11 — Secret management and secret-leak prevention

**Status:** `[x]` done — shipped via PR #29 (merged 2026-09-16): centralized `src/lib/redact.ts` (redactHeaders/redactObject/redactUrl/scrubString/scrubError + shared scan patterns) wired into pipeline telemetry and audit rows, tokenless CI secret-scan job + extended repo scan, 979 unit tests + e2e PASS on live upstream.

**Build:** Inventory all credentials and keep them in deployment/environment secret storage. Add automated secret scanning to CI. Centralize redaction for `Authorization`, cookies, API keys, Clerk secrets, Redis credentials, database URLs, and similar values. Ensure errors and telemetry never serialize raw request headers or secret-bearing objects.

**Test:** Inject fake secrets into headers, request bodies, environment variables, and thrown errors; inspect logs, traces, test output, responses, and snapshots for exact-secret leakage. Run CI secret scanning against a fixture that intentionally resembles a secret and verify detection. Verify client bundles contain no server-only secret names/values.

**Exit:** Secret leakage is mechanically difficult, detectable, and tested.

## Phase 12 — Distributed Redis rate-limit engine

**Status:** `[x]` done — shipped via PR #30 (merged 2026-09-17): Upstash sliding-window engine (burst 60/10s + sustained 100/60s, one atomic Lua EVAL per check, fail-closed 503) behind the existing provider seam, unconfigured path byte-identical, with 28 unit tests + e2e PASS on live upstream (real Redis OSS via mock Upstash REST). Note: no live Upstash run (no UPSTASH_* creds in CI; live test self-skips); sustained 100/60s is a Part-A-compat placeholder until Phase 13 makes it plan-configurable.

**Build:** Use Upstash Redis for distributed enforcement across Vercel/serverless instances. Centralize policy in `src/lib/rate-limit`. Routes declare endpoint class/cost rather than implementing their own counters. Support dimensions such as anonymous IP, authenticated user, project/org, and protected endpoint class. Start with burst + sustained controls using a sliding-window or token-bucket model where appropriate.

**Test:** Launch two application instances against the same Redis and send requests alternately; verify one shared limit is enforced. Repeat with different instances and processes. Verify a request cannot bypass a user/key limit by switching clients while retaining the same principal. Inspect `429` behavior under controlled bursts.

**Exit:** Rate limits are global to the logical principal, not local to a process.

## Phase 13 — Weighted-credit operation catalog

**Status:** `[x]` done — shipped via PR #31 (merged 2026-09-17): versioned `src/lib/quota.ts` catalog (`2026-09-17.free.v1`, 44 route labels: cheap 1 / medium 2 / transcript+audio 3 / combined 4, batch ceiling 20) wired into the pipeline rate-limit cost + usage stamping with fail-closed unknown-operation 500, batch preflight `batch_cost_exceeded`, pinned prior-version snapshot for historical rows, with 1030 unit tests + e2e PASS on live upstream (weighting proof: 10×health admitted vs 7×transcript rejected).

**Build:** Implement the weighted-credit model. **Credit: Utkarsh's weighted-credit model idea** — TubeLens should meter API consumption with a common credit system where cheap and expensive operations consume different numbers of credits. Begin with policy defaults such as metadata/search `1`, comments `2`, transcript `3`, composed `4–5`, and batch = sum of protected child costs with a hard ceiling. Keep costs versioned so historical usage is never reinterpreted under today's price.

**Test:** Unit-test every endpoint's declared operation class and cost. Send cheap and expensive requests and verify different credit deductions. Change a policy version in a test environment and verify historical ledger rows retain the original version/cost. Attempt an unknown endpoint class and confirm it fails closed rather than silently becoming free.

**Exit:** Every billable/quotable operation has a deterministic, centrally defined cost.

## Phase 14 — Quota accounting and monthly allowance

**Status:** `[x]` done — shipped via PR #32 (merged 2026-09-17): monthly UTC-window allowance (Free 10,000), pipeline quota stage, real `GET /quota` balance, `usage_ledger` table + migrations (0000 + 0001 covering index), with 1068 unit tests + e2e PASS on live upstream. Note: atomic reserve/release deferred to Phase 15 (Redis Lua); durable-migrate apply still needs owner Neon credentials.

**Build:**
- Goal: monthly weighted-credit accounting per principal, 10k free credits (`product.ts` `monthlyCredits`, cost from `quota.ts`).
- Decision rule: Redis = fast enforcement (check/reject now), Postgres = durable truth (ledger forever).
- Redis: key `quota:v1:{principal}:{YYYY-MM}`, INCRBY cost + EXPIRE at month reset, 1 cmd/request. Lua check-and-charge. Fail-safe 503 on Redis down (never fail-open).
- Postgres: `usage_ledger` table (principal, operation, cost, policyVersion, window YYYY-MM, outcome accepted/rejected, requestId, timestamp) + `quota_windows` summary. Drizzle migration. Background write via waitUntil, 500ms bound.
- Pipeline order (`pipeline.ts`): resolve cost via `quota.ts` → Redis pre-check → serve → record accepted/rejected to both Redis (sync) + Postgres (async). Cache hits still charge. Batch = summed preflight cost. Unknown op = fail-closed.
- `/quota` route: upgrade stub to real remaining/reset/allowance per `PLANS_AND_USAGE.md` §5, §8.
- Tests/exit: 10k-balance exact, reject at zero with `quota_exceeded` 429 + `Retry-After`, month-rollover, restart durability (rebuild Redis from Postgres), Redis-down 503.
- Files: drizzle migration, new `src/lib/quota-accounting.ts`, `pipeline.ts` wiring, `usage.ts` replace noop, `quota` route.

**Test:** Start a test account with 10,000 monthly credits. Consume known costs and verify exact remaining balance. Drive usage to zero and verify the next charge is rejected. Move the clock across a reset boundary and verify a new window. Restart the application and verify durable usage remains correct when Postgres accounting is enabled.

**Exit:** Usage is deterministic, durable where required, and explainable.

## Phase 15 — Rate limit vs quota vs cache separation

**Status:** `[x]` done — shipped via PR #35 (merged 2026-09-17): pipeline/`cached()` seam contract tests (13 tests: charge-regardless-of-cache, clearCache isolation, PG-absent transcript serving, no-store + stale headers) with zero behavioral change; invariant 1 scoped to `withRequestContext`, route-wide wiring tracked as follow-up #34.

**Build:** Hardening-only separation of three subsystems (no new infra):

- **Goal:** rate-limit = can-request-now (Redis sliding-window burst 60/10s + sustained 100/60s); quota = monthly allowance consumed (Redis fast-check + Postgres ledger from Phase 14); cache = avoid upstream (L0 in-memory + CDN Part A, transcripts never live-only).
- **Invariants:** cache-hit served through `withRequestContext` still faces rate-limit + quota charge (data routes not yet wired through the pipeline are tracked follow-up #34); cache-miss must charge usage; `clearCache()` must never delete `usage_ledger` (monthly windows derive from its `window_id` column — no separate `quota_windows` table was shipped in Phase 14, and none is added here by design: a summary table would itself be a second source of truth, violating the exit criterion); removing Postgres must not break Part A transcript serving.
- **Pipeline order:** `auth → rate-limit` (cost via `quota.ts`) `→ service` (cache lookup inside, but charge regardless) `→ accounting`. Correction to the earlier sketch ("Redis INCRBY + async PG ledger via `waitUntil`"): the quota *charge* is synchronous in-request (peek pre-handler + consume post-response against the `QuotaStore` — in-memory default, Postgres ledger when opted in), so a dropped deferred task can never lose a charge; only the usage-*telemetry* event is best-effort deferred (`setTimeout`, 500ms bound). No `waitUntil`/new infra in this phase.
- **Cache rules:** `quota`/`batch`/`audio` = `private, no-store`; serve-stale-on-error sets `meta.cached: true` + `warnings[]`. Transcripts stay out of Postgres unless a later explicit storage/cost/privacy decision enables it.
- **Deferred (deliberate, not drift):** quota reserve/release Lua (distinct from the existing rate-limit Lua) stays deferred — the peek+consume race is acceptable for this hardening phase (over-admission bounded by the burst limiter; billing-key dedup makes double-charge mechanically impossible). Most data routes still call `handleX()` directly instead of `withRequestContext`, so the invariants are pinned at the pipeline/`cached()` seam by contract tests; wiring every route behind the pipeline is tracked follow-up #34 (it changes anonymous-quota behavior — shared bucket — so it needs its own product decision), NOT Phase 16 batch economics.

**Test:** Contract tests for the 4 invariants above, no new infra.

**Exit:** No subsystem is used as another's source of truth.

> **Note:** blocked on Phase 14 (needs quota-accounting + `usage_ledger` first); Phase 15 is hardening-only.

## Phase 16 — Batch protection and partial-abuse resistance

**Status:** `[ ]` not started.

**Build:** Define deterministic batch semantics: maximum child count, maximum total weighted cost, preflight vs incremental charging, partial-failure behavior, and response accounting. Prevent a batch from bypassing per-operation limits or turning one network call into unlimited upstream work.

**Test:** Submit valid batch within limits. Submit batch one item over the maximum. Submit batch with mixed cheap/expensive operations. Submit a batch whose calculated cost exceeds remaining credits. Retry the same batch and verify semantics are deterministic. Verify no hidden child calls occur after the batch is rejected.

**Exit:** Batch endpoints have explicit bounded economics and resource consumption.

## Phase 17 — Abuse controls and anomaly detection

**Status:** `[ ]` not started.

**Build:** Add configurable deny/block controls for obvious abuse: excessive failed authentication, credential spraying, repeated rejected requests, pathological batch patterns, or other high-confidence signals. Controls apply to both `session_token` and `api_key` (Phase 05) principals. Keep automatic blocking conservative and reversible. Store security decisions with enough context for operators without retaining unnecessary sensitive input.

> **Clerk ban via API — yes (Route Handler, server-only).** Ban/unban/revoke/downgrade all run from a `runtime = "nodejs"` Route Handler with `import "server-only"`. Requires `CLERK_SECRET_KEY` server-only (never client). Package `@clerk/nextjs` not yet installed — add it in the abuse-control PR.
>
> ```ts
> import "server-only";
> import { clerkClient, authenticateRequest } from "@clerk/nextjs/server";
> const client = await clerkClient();
> await client.users.banUser(userId);                    // POST /v1/users/{id}/ban — takes userId only, no reason param
> await client.users.unbanUser(userId);                  // POST /v1/users/{id}/unban
> await client.sessions.revokeSession(sessionId);        // revoke one session
> await client.users.updateUserMetadata(userId, { publicMetadata: { tier: "free" } }); // downgrade
> const { isAuthenticated } = await authenticateRequest(req); // re-verify after action
> ```
>
> Docs: ban — https://clerk.com/docs/reference/backend/user/ban-user · unban — https://clerk.com/docs/reference/backend/user/unban-user · revoke session — https://clerk.com/docs/reference/backend/session/revoke-session · verify — https://clerk.com/docs/reference/backend/authenticate-request · metadata — https://clerk.com/docs/reference/backend/user/update-user-metadata
>
> **Auto-ban layer design (future `src/lib/abuse.ts`).** Pure function `checkAbuse(signal) → "ok" | "warn" | "revoke" | "downgrade" | "ban-queued"`, backed by in-memory counters (`Map<key, {count, windowStart}>`, cooldown 5–15 min per signal). Auto-enacts only `warn` / `revoke` / `downgrade`; `ban-queued` never auto-executes — it writes an audit row and queues for manual admin approval (human clicks unban/ban in Dashboard or admin endpoint). Existing stubs reused: `envelope.ts` (`X-Request-Id`/`X-RateLimit-*`), `errors.ts` (`Retry-After: 60` on 429), `utils.ts` (`QUOTA_LIMIT 100/60s`), `validate.ts` (`limit` 20/50), batch max 10 + 8s fail-fast.
>
> | Signal | Threshold (sliding window) | Auto action | Notes |
> | ------ | -------------------------- | ----------- | ----- |
> | 429 rate-limit hits | ≥10/10min → `warn`; ≥25/10min → `revoke` | warn then session revoke | cooldown 10min; never auto-ban |
> | Quota empty (weighted credits exhausted) ×3 consecutive windows | 3 windows → `downgrade` | downgrade tier one step (never below `free`) | ranked `free<plus<pro<enterprise`; re-check authoritative metadata |
> | 400 validation spam | ≥20/5min → `warn` | warn + `Retry-After: 60` | cooldown 5min |
> | Batch abuse (oversize/cost-overrun rejects) | ≥5/10min → `warn` | warn | batch stays max-10, cost-capped |
> | Invalid-token / auth failures | ≥5/5min → `revoke` | revoke session(s) | cooldown 15min |
> | 8s-timeout churn (client retries hammering slow upstream) | any sustained churn → `warn` only | warn only, never revoke/ban | protects legit slow-network users |
>
> **Ban vs revoke vs downgrade runbook.**
>
> | Action | When | Effect window | Freshness rule |
> | ------ | ---- | ------------- | -------------- |
> | `warn` (429 + `Retry-After: 60`) | thresholds above, first rung | immediate, expires with window | stateless per response |
> | `revoke` (`sessions.revokeSession`) | credential spraying, invalid-token ≥5/5min, 429 ≥25/10min | immediate; concurrent in-flight requests drain ≤60s | re-verify via `authenticateRequest`; session claims lag ~60s so never trust stale claim alone |
> | `revoke` (`apiKeys.revoke`) | compromised / leaked `ak_*`, key-based abuse | immediate in Clerk; enforced ≤60s, no cached allow past the window | pass `revocationReason`; never log the secret; audit per `PLANS_AND_USAGE.md` §10 |
> | `downgrade` (`updateUserMetadata` tier step-down) | quota-empty ×3 windows | authoritative metadata immediate; session claim catches up ≤60s | read authoritative `publicMetadata` per security-sensitive request, not the projected claim |
> | `ban-queued` → manual `banUser` | repeated revoke/downgrade evasion, human-confirmed abuse only | ban immediate on approval; unban via `unbanUser` | admin re-verifies authoritative state before approving |
>
> **Revoke-reason rule (Clerk takes no reason).** `banUser`/`revokeSession` accept no reason param — store the reason in our own audit row per mutation: `{ actor, targetUserId, oldTier, newTier, ts, requestId, reason }` (extends `PLANS_AND_USAGE.md` §10 shape). API-key revocation additionally passes `revocationReason` to `apiKeys.revoke()` and writes the same audit row. Never log secrets/tokens/headers — sanitized before/after only.
>
> **MCP `WWW-Authenticate` contract (Part C reuses this).** Auth failures on `/mcp` return `401 + WWW-Authenticate: Bearer resource_metadata="<rfc9728-url>"` with an RFC 9728 protected-resource metadata document; scope failures return `403 insufficient_scope`. The client owns token refresh — the server never mint-and-retry inline.
>
> **Defer list ($0 Hobby — why).** Redis limiter, PG audit ledger, and Datadog abuse monitors are all **deferred**: on Vercel Hobby $0, in-memory counters + stdout logs + Vercel analytics suffice for current volume; durable stores graduate in only when abuse volume or multi-instance drift proves in-memory insufficient.

**Test:** Simulate a threshold number of failed auth attempts and verify the documented response. Simulate abusive traffic from one key and verify only intended principals/dimensions are affected. Test block expiry/unblock. Confirm a normal developer workload near the boundary is not accidentally blocked.

**Exit:** Abuse controls reduce attack surface without becoming a blunt self-inflicted outage mechanism.

## Phase 18 — Datadog tracing foundation

**Status:** `[ ]` not started.

**Build:** Integrate Datadog's Node/Next.js tracing path using the current supported configuration. Trace important request, service, database, Redis, cache, and upstream operations where meaningful. Add service/environment/version tags and correlate spans through request/trace IDs. Keep instrumentation isolated from business logic.

**Test:** Make one representative API request and confirm a complete trace exists from route through important downstream work. Force an upstream failure and verify the trace contains the relevant error span. Verify sampling does not make essential operational signals impossible to inspect.

**Exit:** Operators can follow important requests through the service.

## Phase 19 — Structured logs and redaction

**Status:** `[ ]` not started.

**Build:** Standardize structured logs with request ID, route, status, latency, auth type, endpoint class, rate-limit result, cache result, upstream status, and safe error codes. Centralize redaction and use bounded attributes. Never log authorization headers, session tokens, cookies, or raw secret-bearing payloads.

**Test:** Inspect logs for authenticated, API-key, rate-limited, invalid-input, and upstream-error requests. Search the resulting log stream for known fake secrets and headers. Verify every production log entry can be correlated by request ID without exposing user secrets.

**Exit:** Logs support debugging without becoming a credential database.

## Phase 20 — Metrics, dashboards, and SLO signals

**Status:** `[ ]` not started.

**Build:** Implement the canonical TubeLens metric catalog below. This catalog is
normative: when the observability provider is implemented, every metric marked
`REQUIRED` must have a collector/emission path or a clearly documented native
source (for example Vercel edge analytics). New operationally significant work
must update this catalog rather than inventing ad-hoc metrics in individual
routes.

### Canonical metric catalog

#### 1. Traffic and request volume — REQUIRED
Collect:
- `tubelens.requests.total` — origin requests reaching the application.
- `tubelens.requests.accepted` — requests that reach the service handler.
- `tubelens.requests.rejected` — rejected before service work, split by reason.
- `tubelens.requests.by_endpoint` — request volume by logical operation/route.
- `tubelens.requests.by_tier` — request volume by product tier.
- `tubelens.requests.by_auth_type` — session vs API key vs anonymous where applicable.
- `tubelens.requests.batch_children` — child operations executed inside batch.
- `tubelens.edge_requests.total` — total customer-facing requests seen at the edge/CDN.
- `tubelens.edge_requests.cache_hits` / `cache_misses` — edge cache behavior.

**Important:** edge totals and origin totals are different metrics. CDN hits do
not invoke the Vercel function, so origin-side telemetry must never be treated as
the complete customer traffic count.

#### 2. Latency and performance — REQUIRED
Collect:
- `tubelens.request.duration_ms` — distribution, not just an average.
- p50, p95, p99 request latency by endpoint/operation.
- Upstream duration by provider.
- Redis operation duration.
- Postgres operation duration.
- Authentication/authorization duration when non-trivial.
- Batch total duration and child-operation duration.
- Timeout count and timeout rate.

Use distributions/histograms for latency so percentiles can be computed later.

#### 3. HTTP reliability — REQUIRED
Collect:
- total 2xx / 3xx / 4xx / 5xx.
- 429 rate and count.
- 401 and 403 rate and count.
- 400 / 413 validation rejection rate.
- 404 rate by operation.
- 5xx rate by operation.
- error counts by stable `error.code`.
- success rate / availability by endpoint.
- stale-on-error responses.
- partial-success responses and warnings.
- request cancellation/aborted-handler count where observable.

#### 4. Cache effectiveness — REQUIRED
Collect separately for each cache layer:
- `tubelens.cache.l1_hits` — CDN/edge hit count (native Vercel source where available).
- `tubelens.cache.l1_misses`.
- `tubelens.cache.l0_hits` — in-process memory cache hits.
- `tubelens.cache.l0_misses`.
- `tubelens.cache.stale_served`.
- `tubelens.cache.revalidation` attempts/success/failure.
- Effective cache-hit ratio by endpoint.
- Requests that reached upstream because all applicable cache layers missed.

Never collapse CDN and L0 into one "cache hit" number; they have different cost
and capacity implications.

#### 5. YouTube / external upstream work — REQUIRED
Collect:
- total upstream calls.
- upstream calls by provider/source.
- upstream success/failure/timeout/429/403 counts.
- upstream latency distribution.
- upstream retry count.
- upstream work avoided by cache.
- provider fallback count and winning provider for transcript requests.
- stale served after upstream failure.
- upstream calls per successful API request.
- upstream calls per 1,000 weighted credits.

For the transcript provider chain, also collect provider-attempt count,
fallback count, final provider, and provider failure reason without logging
request secrets or raw transcript payloads.

#### 6. Redis health and rate limiting — REQUIRED
Collect:
- Redis operation count.
- Redis latency distribution.
- Redis errors/timeouts.
- rate-limit checks allowed.
- rate-limit checks rejected.
- rate-limit rejection rate.
- burst-limit rejections.
- sustained-limit rejections.
- quota enforcement checks and failures.
- Redis fail-closed events.
- Redis availability.

#### 7. Postgres / durable accounting — REQUIRED
Collect:
- database query count where useful.
- query latency distribution for important paths.
- connection/query errors.
- usage-ledger write success/failure.
- usage-ledger write latency.
- durable usage-accounting lag/backlog if asynchronous delivery exists.
- quota reconciliation discrepancies.
- migration/health-check failures.

Do not turn every SQL statement into a custom metric; instrument important
operations and dependency health.

#### 8. Quota, credits, and plan economics — REQUIRED
Collect:
- weighted credits consumed.
- weighted credits rejected due to quota.
- credits by operation class.
- credits by tier.
- credits by endpoint/operation.
- quota-exhaustion count and rate.
- quota remaining distribution/buckets.
- monthly active principals consuming credits.
- average credits/request.
- average credits per active user.
- paid vs free credit consumption.
- paid vs free origin-request consumption.
- paid vs free upstream-call consumption.
- policy-version usage distribution.

These are product-economics metrics. They must remain consistent with the durable
usage ledger and must not make Datadog the source of truth.

#### 9. Customer / account usage — REQUIRED, but bounded
Collect:
- active API users/principals.
- active API keys.
- requests per tier.
- credits per tier.
- usage concentration (top consumers as bounded aggregates).
- number of principals nearing quota.
- number of principals exhausting quota.
- number of rate-limited principals.

Do not use raw `user_id`, API key, IP, or request ID as unbounded custom-metric
tags. Use logs/traces for individual investigations and bounded dimensions for
metrics.

#### 10. Authentication, authorization, and abuse — REQUIRED
Collect:
- authentication success/failure counts by safe reason.
- authorization denial counts.
- revoked/expired credential attempts.
- invalid API-key attempts.
- suspicious burst/rejection signals.
- abuse-control warnings/revocations/downgrades/queued bans.
- credential issuance/revocation/rotation counts as operational counters.
- admin/security-action counts.

Security events must remain sanitized and must never contain credentials/tokens.

#### 11. Dependency and platform health — REQUIRED
Collect:
- Clerk dependency success/failure/latency.
- Upstash dependency success/failure/latency.
- Neon dependency success/failure/latency.
- Datadog telemetry delivery/drop/failure where available.
- Vercel deployment/runtime health.
- application process cold starts where available.
- function execution duration/resource indicators exposed by the platform.
- provider/session health for YouTube/Innertube.
- health endpoint success/failure.

#### 12. Deployment and release health — REQUIRED
Collect:
- deployment count.
- deployment failure count.
- deployment rollback count.
- application errors by deployment/version.
- latency/error-rate comparison by deployed version.
- time since last successful deployment.
- health-check status by version/environment.

#### 13. SLO / alerting signals — REQUIRED
Create derived monitors for:
- API availability / successful-response rate.
- p95 and p99 latency by critical endpoint.
- 5xx rate.
- 429 surge.
- upstream failure surge.
- cache-hit-rate drop.
- InnerTube/upstream calls per request rising unexpectedly.
- Redis error/latency surge.
- Postgres error/latency surge.
- quota exhaustion surge.
- paid/free capacity imbalance against the configured allocation.
- telemetry pipeline failure.
- deployment regression.

### Canonical metric dimensions

Use a small, bounded dimension set:

`environment`, `service`, `version`, `route`, `operation`,
`method`, `status_class`, `error_code`, `tier`, `auth_type`,
`cache_layer`, `cache_result`, `upstream_provider`, `upstream_result`.

Only add a dimension when its value space is demonstrably bounded. Individual
`user_id`, API key, raw URL, IP address, request ID, video ID, search query,
transcript text, or other unbounded identifiers belong in sanitized logs/traces
when needed for investigation, not in high-volume custom metrics.

### Metric ownership / source mapping

| Signal | Primary source |
|---|---|
| Total customer-facing edge traffic | Vercel edge/CDN analytics |
| CDN hit/miss | Vercel edge/CDN analytics |
| Origin request volume | TubeLens instrumentation / Vercel function telemetry |
| Request latency / HTTP status | TubeLens instrumentation + Vercel |
| Cache L0 | TubeLens cache instrumentation |
| Redis rate-limit health | TubeLens + Upstash metrics |
| Postgres/usage ledger health | TubeLens + Neon/Postgres |
| Weighted credits / quota | Postgres usage truth + TubeLens emission |
| Individual request investigation | Datadog logs/traces |
| Aggregate operational metrics | Datadog metrics |
| Deploy/runtime health | Vercel + Datadog |

### Implementation rule

Every metric above must have one of these explicit states before Phase 20 exits:
`implemented`, `native-source-linked`, or `intentionally-not-applicable`
with a reason. No "we'll remember later" metrics are allowed.

**Test:** Generate controlled traffic/errors and verify metric increments and
dimensions are correct. Compare one endpoint against another. Exercise cache-hit
and cache-miss paths, upstream success/failure, Redis success/failure, quota
accept/reject, authentication failures, and batch requests. Deploy a deliberately
isolated test regression and verify the relevant dashboard signal changes. Ensure
high-cardinality raw identifiers are not used indiscriminately as metric labels.
Verify edge/CDN traffic is not accidentally inferred from origin function counts.

**Exit:** Datadog answers what is happening across traffic, performance,
reliability, caching, upstream work, infrastructure health, quota/economics,
customer usage, security, and deployments without overwhelming itself with
useless cardinality.
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

**Build:** Implement the audit model from [`PLANS_AND_USAGE.md`](./PLANS_AND_USAGE.md) for security-sensitive events: tier changes, project/security changes, privileged actions, abuse blocks, credit adjustments, and future posting/mutations. Store actor, action, resource, timestamp, request ID, sanitized before/after values, and reason/source. Do not permanently audit every high-volume normal read.

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

**Test:** Complete the flow entirely from the UI and direct API: sign in → call API → see usage → hit a rate limit. Attempt the same controls directly over HTTP with missing/incorrect authorization and verify backend enforcement.

**Exit:** Product controls are usable without weakening the actual API security boundary.

## Phase 27 — Supply-chain and CI security

**Status:** `[ ]` not started.

**Build:** Add dependency vulnerability checks, lockfile review, secret scanning, and security-sensitive CI checks. Pin/lock dependencies appropriately. Review new packages for necessity and scope. Keep production and test dependencies separated where practical.

**Test:** Introduce a deliberately vulnerable test dependency in a branch and verify CI flags it. Introduce a fake secret fixture and verify secret scanning fails. Verify lockfile-only changes are visible in review. Remove/upgrade the test package and verify CI returns green.

**Exit:** Repository changes are continuously checked for common supply-chain and credential mistakes.

## Phase 28 — Adversarial security E2E suite

**Status:** `[ ]` not started.

**Build:** Extend the GitHub E2E agent's responsibilities from functional regression into adversarial API testing. It may start isolated Redis, Postgres, telemetry stubs/collectors, and supporting services in Docker. Tests must not modify product code/config to make themselves pass.

Mandatory scenarios include: missing auth, malformed credentials, expired/revoked session or API key, forged tier, unauthorized project access, oversized request, huge pagination, pathological batch, rapid burst, sustained abuse, concurrent quota consumption, Redis outage, Postgres restart, Datadog outage, upstream timeout, retry behavior, idempotency replay, audit emission, and secret leakage checks.

**Test:** Every scenario must assert both the HTTP contract and side effects: no unauthorized database access, no hidden upstream work, correct credit deductions, expected Redis state, correct audit entries where applicable, and safe telemetry. Run the suite against at least two application processes sharing the same Redis.

**Exit:** Security behavior is executable and regression-tested, not merely documented.

## Phase 29 — Production-readiness, rollback, and incident procedures

**Status:** `[ ]` not started.

**Build:** Document operational procedures for session / API-key credential revocation, abuse blocks, tier correction, quota-policy rollback, Redis/Postgres recovery, Datadog investigation, deployment rollback, and incident escalation. Define retention/backup expectations for durable product data. Validate migrations and policy changes are reversible or safely forward-only by design.

**Test:** Conduct tabletop or automated drills: revoke a compromised session or API key; roll back a bad quota policy; restart Redis; restore/reconnect Postgres; roll back a deployment; inspect a Datadog incident using request IDs. Record exact operator steps and verify they work without manual database surgery wherever a supported control exists.

**Exit:** The service can be operated safely during an incident, not only during normal traffic.

## Phase 30 — Final integration and production security gate

**Status:** `[ ]` not started.

**Goal:** prove the complete Part B platform as one coherent system before depending on it from Part C MCP.

**Mandatory acceptance matrix:**
- Clerk user authentication works.
- Default tier is Free and cannot be self-escalated.
- Admin tier mutation is authenticated, authorized, auditable, and reflected in effective entitlements.
- Clerk API keys authenticate machines without storing plaintext secrets.
- Machine (API-key) issuance / revocation follows the Phase 05 401/403/400/200 matrix with ≤60s revoke effect.
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

**Definition of done:** TubeLens has a production-minded secure API platform: identity and machine authentication are controlled by Clerk — interactive sessions plus non-interactive API keys (Phase 05), coexisting with MCP user-OAuth via `@xmcp-dev/clerk`; authorization is enforced at resource boundaries; distributed rate limits and weighted credits control consumption; durable product state is kept in Postgres only where genuinely necessary; Part A transcript caching stays CDN/in-memory by default; Datadog provides actionable backend observability; secrets and internal network access are protected; security events are auditable; failure modes are explicit; and a repeatable adversarial E2E suite proves the controls before Part C MCP inherits them.
---

## Part C — XMCP MCP (post-REST, after Part B account/security layer)

> **Gate:** Part A (REST v1) remains complete before MCP implementation. Part C
> assumes Part B has established product identity, Clerk authentication,
> rate-limiting/quota policy, and any required write/posting policy. MCP is a
> thin agent interface over the existing TubeLens service/domain layer — never
> a second YouTube integration and never a duplicate business-logic layer.

**Target protocol:** MCP `2026-07-28`.

**Framework:** **XMCP v1** with its Next.js integration, targeting the modern
stateless Streamable HTTP transport and MCP SDK v2 underneath. The integration
must be validated against the exact XMCP version selected at implementation time
before marking B0 complete; do not assume that an XMCP package release supports
all protocol features merely because it advertises Streamable HTTP.

**Deployment target:** existing Next.js 16 App Router on Vercel, one public
MCP endpoint at `/mcp`, no Redis/session store by default. The normal REST API
continues under `/api/v1`.

**Core design rule:** MCP is a **thin wrapper** — each tool authenticates the caller via Clerk, calls the **same shared service functions** as the REST Route Handlers, and returns the same data. No HTTP loopback to `localhost/api`, no separate business logic. This avoids an unnecessary network hop and guarantees REST and MCP use the same validation, caching, upstream clients, typed errors, and business rules.

> **Foundation (built in Part B, consumed here):** `src/lib/auth.ts` (`AuthContext`, `getEffectiveTier`, `requireAuth`/`requireAdmin`) + `src/lib/quota.ts` (operation → cost map) serve REST first. MCP later = one PR: `bun add xmcp @xmcp-dev/clerk`, `clerkProvider` in `src/middleware.ts`, `/mcp` route whose tools reuse those files plus envelope/cache/cursor helpers.

### C0 — Protocol + framework spike

**Status:** `[ ]` not started.

**Goal:** Prove that XMCP can be embedded into the current Next.js app and serve
MCP `2026-07-28` correctly before building the complete tool catalog.

**Implementation:**
- Add XMCP using the existing Next.js application rather than creating a second app.
- Establish `/mcp` as the single Streamable HTTP endpoint.
- Confirm the deployed runtime is compatible with XMCP's required Node/web APIs.
- Register only two read-only tools: `search` and `get_video`.
- Ensure tool input schemas reuse TubeLens Zod 4 validators where practical.
- Keep all tool handlers free of direct `youtubei.js` calls; tools call the same shared service fns as REST (thin wrapper, no `localhost/api` loopback) with auth-before-tool via `src/lib/auth.ts`.
- Verify local development and a production-like Vercel deployment.

**Protocol gate:** verify the modern `2026-07-28` wire behavior:
- no protocol-level MCP session state;
- no dependence on `Mcp-Session-Id`;
- each HTTP request can be handled independently;
- `MCP-Protocol-Version` and required request metadata are handled correctly;
- `Mcp-Method` / `Mcp-Name` behavior is correct where required by the transport;
- `server/discover` is available as required by the selected MCP implementation;
- request-scoped JSON or SSE responses work correctly;
- cancellation and error propagation do not depend on sticky server instances.

**Exit criteria:**
- MCP Inspector can connect to `/mcp` and discover both tools.
- A fresh request succeeds even when no prior MCP request has touched that
  server instance.
- Two concurrent requests are independent and produce correct results.
- The same tool call succeeds when routed to different execution instances.
- REST behavior and production API tests remain unchanged.
- No session database, Redis, or process-affinity mechanism is required.

### C1 — Shared MCP adapter contract

**Status:** `[ ]` not started.

**Goal:** Create the reusable boundary between TubeLens's existing API/domain
logic and MCP.

**Implementation:**
- Define a small internal service interface for search, video, channel,
  playlist, music, feed, and utility reads — the same fns REST handlers call (one implementation, two adapters; no MCP-only business logic, no HTTP loopback).
- Reuse existing Zod schemas instead of creating parallel MCP-only DTOs.
- Define an MCP result mapper that converts internal results into
  MCP structured content.
- Preserve useful `warnings`, typed error codes, pagination cursors, and
  request IDs without blindly copying the entire HTTP envelope into every tool.
- Keep REST response envelopes unchanged.
- Ensure an MCP tool cannot bypass REST/domain authorization, quota, cache,
  timeout, or abuse controls.

**Contract rule:** one underlying service → REST adapter + MCP adapter.
There must not be one implementation for REST and another for MCP.

**Exit criteria:**
- `search` and `get_video` are backed by shared services.
- Unit tests prove identical core results for equivalent REST and MCP calls.
- Schema drift cannot occur silently between REST and MCP.

### C2 — Agent-first tool surface

**Status:** `[ ]` not started.

**Goal:** Expose the highest-value TubeLens capabilities as semantic tools,
not a mechanical one-tool-per-REST-route mirror.

**Initial tool groups:**

**Discovery**
- `search`
- `search_suggestions`
- `get_hashtag`

**Video**
- `get_video`
- `get_related_videos`
- `get_comments`
- `get_captions`
- `get_transcript`
- `get_sponsors`
- `get_dislikes`
- `get_dearrow`
- `get_combined_video`

**Channel**
- `get_channel`
- `get_channel_videos`
- `get_channel_shorts`
- `get_channel_streams`
- `get_channel_playlists`
- `get_channel_rss`

**Playlist**
- `get_playlist`
- `get_playlist_items`

**Music**
- `search_music`
- `get_music_charts`
- `get_artist`

**Feeds**
- `get_shorts_feed`
- `get_live_feed`
- `get_gaming_feed`

**Utility / optional later**
- `get_mix`
- `get_thumbnail`
- `get_instances`
- `get_quota`
- `get_radio`
- `get_lyrics`

**Tool design rules:**
- Tool names describe an agent intent, not an HTTP implementation detail.
- Descriptions explain when to use the tool and what it returns.
- Inputs are strict and minimal; do not expose irrelevant REST query parameters.
- Pagination must use explicit cursors/limits with stable semantics.
- Read-only tools are preferred before any user-state mutation tool.
- `batch` is not exposed as a generic MCP tool initially; only add it if real
  client workloads demonstrate that it improves agent behavior without making
  tool selection ambiguous.

**Exit criteria:**
- Tool catalog is coherent enough for an LLM to choose the correct tool without
  relying on hidden implementation knowledge.
- Every tool has schema validation, useful descriptions, structured output,
  typed failure behavior, and at least one representative fixture test.

### C3 — Stateless transport + explicit application state

**Status:** `[ ]` not started.

**Goal:** Make statelessness a deliberate architectural property instead of a
configuration accident.

**Rules:**
- No MCP protocol session store.
- No assumption that two calls from one agent hit the same Vercel instance.
- No sticky sessions.
- No hidden cross-request state in module-level mutable objects that changes
  tool semantics.
- Any state that truly needs to survive between calls must be represented by
  an explicit, server-minted handle passed as a normal tool argument.
- Stateless read tools should remain fully reconstructible from each request.

**Tests:**
- cold-instance tool call;
- concurrent tool calls;
- reordered tool calls;
- repeated tool calls;
- instance handoff simulation;
- cache hit/miss across different instances;
- explicit handle round-trip for any future stateful workflow.

**Exit criteria:**
A load-balanced deployment can process every read request without a shared MCP
session store while preserving correct pagination, authorization, caching,
and error semantics.

### C4 — Clerk integration boundary

**Status:** `[ ]` not started.

**Goal:** Consume the Part B Clerk identity/authentication layer rather than
inventing separate MCP identity handling.

**Rules:**
- MCP requests use the same canonical Clerk identity model from Part B for both credential types — interactive `session_token` (user-OAuth via `@xmcp-dev/clerk`: DCR + PKCE + consent, `getSession()` / `getUser()`) and non-interactive `api_key` (Phase 05 machine credential tied to `subject` `user_xxx`). Both resolve to the same Clerk user identity as REST — no separate principals, no shadow user records.
- Authentication happens before tool execution: `clerkProvider` in `src/middleware.ts` (JWKS Bearer verify, DCR enabled in Clerk Dashboard); each tool calls `getSession()` for fast claims (`tubelens.tier` → `getEffectiveTier()`, fallback `free`) and avoids `getUser()` on the hot path. Verification accepts both token types (`acceptsToken: ["session_token", "api_key"]`) and switches on `tokenType`; key callers project the same `tubelens.tier` claim → `getEffectiveTier()` with `free` fallback.
- Authorization/scopes are checked before invoking sensitive tools.
- Anonymous/public tools and authenticated tools are explicitly classified.
- User identity is passed into the shared service layer only when needed.
- MCP must never create a second user system or shadow Clerk user records.

**Future-proofing:** leave a clean boundary for OAuth/CIMD-style MCP
authorization evolution without requiring it for the first public read-only
release.

**Exit criteria:**
- Unauthenticated access follows the public policy from Part B.
- Authenticated calls resolve to the same Clerk identity as REST.
- A revoked/invalid credential cannot execute tools.
- Tool authorization failures return a useful typed MCP error.

### C5 — Rate limiting, quota, and abuse controls

**Status:** `[ ]` not started.

**Goal:** Apply the Part B rate-limit/quota policy consistently to MCP.

**Implementation:**
- Reuse the canonical TubeLens quota/rate-limit service: `src/lib/quota.ts` costs + Part B Redis enforcement; tools charge exactly like their REST equivalents.
- Meter by the identity key selected in Part B (for example user, API key,
  anonymous principal, and/or tool class as appropriate).
- Optionally meter by MCP method/tool name using the protocol's HTTP metadata,
  rather than parsing every request body in an upstream gateway.
- Preserve useful retry information in MCP errors.
- Keep expensive tools such as transcripts, combined data, radio, or any future
  proxy/audio operation subject to their own budget policy.

**Exit criteria:**
- Repeated MCP calls hit the same quota policy as equivalent REST calls.
- 429/rate-limit behavior is typed, deterministic, and testable.
- A single client cannot bypass limits by switching MCP tools that ultimately
  consume the same protected upstream budget.

### C6 — Discovery and server metadata

**Status:** `[ ]` not started.

**Goal:** Make TubeLens discoverable and understandable by modern MCP clients.

**Implementation:**
- Implement and verify `server/discover` behavior for protocol `2026-07-28`.
- Publish accurate server identity/version metadata.
- Define concise server instructions that help an LLM understand TubeLens's
  scope without duplicating every tool description.
- Publish/verify the MCP Server Card / well-known discovery metadata supported
  by the selected XMCP version.
- Keep discovery metadata cache-friendly and deterministic.
- Cross-link MCP discovery to the public developer docs and REST OpenAPI spec.

**Exit criteria:**
- A compatible client can discover supported protocol version(s), capabilities,
  identity, and instructions.
- Tool catalog ordering is deterministic.
- Documentation and advertised capabilities match deployed behavior.

### C7 — Modern Streamable HTTP correctness

**Status:** `[ ]` not started.

**Goal:** Validate the transport itself, not just tool execution.

**Test matrix:**
- POST with valid `MCP-Protocol-Version`.
- Invalid/mismatched protocol version.
- Missing/invalid required metadata.
- `tools/list` and `tools/call`.
- JSON response mode.
- Request-scoped SSE response mode where supported/used.
- Cancellation by closing the response stream.
- Malformed JSON-RPC.
- Unknown tool.
- Tool schema validation failure.
- Upstream timeout.
- Upstream 429/5xx.
- Auth failure.
- Origin validation / DNS-rebinding defense for the HTTP endpoint.
- Multiple simultaneous clients.

**Exit criteria:**
All transport cases pass locally and against the production deployment, with
no reliance on legacy MCP session behavior for the modern protocol path.

### C8 — Client compatibility

**Status:** `[ ]` not started.

**Goal:** Validate that TubeLens works as an actual agent tool server, not just
as a protocol-compliant HTTP endpoint.

**Clients / tools:**
- MCP Inspector;
- at least one major coding/agent client that supports remote MCP;
- one additional generic Streamable HTTP MCP client;
- direct protocol fixture client for deterministic CI tests.

**Scenarios:**
- discover server;
- list tools;
- choose `search` for natural-language discovery requests;
- resolve a video and then call `get_video`;
- follow pagination;
- use transcript/comments/related tools in sequence;
- handle warnings and typed failures;
- authenticate with Clerk-backed credentials where enabled;
- recover after a transient upstream failure.

**Exit criteria:**
At least three independent clients/fixtures can discover and call the production
MCP surface successfully, with the same observable data semantics as the REST
services.

### C9 — Performance and caching

**Status:** `[ ]` not started.

**Goal:** Preserve TubeLens's existing $0 architecture and make MCP cheap.

**Rules:**
- MCP must reuse existing CDN/in-memory caches where possible.
- Do not add Redis solely to maintain MCP sessions.
- Deterministic list/discovery responses should be cacheable where the protocol
  and deployment allow it.
- Cache keys must include all identity or locale inputs that materially change
  the result.
- Cache public tool catalogs separately from authenticated/user-specific data.
- Track MCP latency separately from upstream TubeLens latency.

**Exit criteria:**
- Warm/cold latency is measured for the top 5 tools.
- No duplicate upstream request is introduced solely because the caller is MCP.
- Memory usage remains bounded on a long-lived Vercel process.

### C10 — Documentation + public developer experience

**Status:** `[ ]` not started.

**Goal:** Turn MCP from an internal endpoint into a usable product surface.

**Docs must include:**
- MCP endpoint URL;
- supported protocol version;
- authentication setup using Part B/Clerk;
- quick connection example;
- available tool catalog;
- example agent prompts;
- pagination examples;
- errors and rate limits;
- REST ↔ MCP mapping;
- server discovery / Server Card information;
- compatibility notes;
- limitations around audio/proxy/legal-gated functionality.

**Exit criteria:**
A new developer can go from the marketing/docs site to a working MCP connection
without reading TubeLens source code.

### C11 — Production release gate

**Status:** `[ ]` not started.

**Mandatory pre-launch gates:**
- all Part C unit/contract/e2e tests pass;
- `tools/list` contains no dead tools or undocumented tools;
- server discovery metadata matches the deployed build;
- Clerk authentication and Part B rate limits are enforced;
- no MCP session state exists in production;
- production logs contain request IDs and tool/method context without leaking
  credentials or sensitive user data;
- REST regression suite remains green;
- production MCP endpoint passes Inspector and at least two additional client
  compatibility checks;
- public docs match the live tool catalog;
- rollback path is tested;
- audio/write/mutation capabilities remain disabled unless their separate legal,
  abuse, and authorization gates have been cleared.

**Definition of done:**
TubeLens is a production MCP server that an agent can discover, authenticate,
select tools from, execute independently across server instances, paginate,
handle errors/rate limits, and use against the same reliable domain services as
REST — with no protocol session store and no duplicated YouTube integration.