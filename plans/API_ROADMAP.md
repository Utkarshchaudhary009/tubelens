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
>
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

**Goal:** Answer "what's popular and what did you mean" beyond raw search.

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

**Status:** `[ ]` not started

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

**Status:** `[ ]` not started

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

**Status:** `[ ]` not started

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

**Status:** `[ ]` not started

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

**Goal:** The "composed killers": crowd-sourced layers no official API offers,
plus one combined call that makes the frontend trivial. Durable persist
(Upstash/R2 free tier) is OPTIONAL here only — default stays CDN + in-memory.

**Status:** `[ ]` not started

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

**Status:** `[ ]` not started

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

**Status:** `[ ]` not started

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
