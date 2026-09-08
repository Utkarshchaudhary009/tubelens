# TubeLens Caching (zero-cost ladder)

$0 rule: L0 + L1 are the default for Phases 1–7. L2 (free-tier durable) is
OPTIONAL and only when a phase explicitly demands it.

## Ladder

| Level | What | Cost | Use for |
| ----- | ---- | ---- | ------- |
| L0 | In-memory (`Map`/LRU per route) | $0 | Dedupes hot keys within one region/instance |
| L1 | CDN `Cache-Control: s-maxage` + SWR | $0 (Vercel free) | Absorbs repeat reads across users |
| L2 | Durable free tier (Upstash Redis / R2 / Neon) — OPTIONAL | $0 cap | Only transcript persist, abuse blocklists, or quota windows when gated |

## TTL table (`Cache-Control: public, s-maxage=<ttl>, stale-while-revalidate=<swr>`)

| Group | Example routes | s-maxage | SWR |
| ----- | -------------- | -------- | --- |
| Static-ish | `videos/:id`, `channels/:id`, `captions` | 3600 | 86400 |
| Transcripts (aggressive) | `videos/:id/transcript` | 86400 | 86400 |
| Fast-moving | `trending`, `feed/*`, `music/charts` | 300–900 | 3600 |
| Autocomplete | `search/suggestions` | 300 | 1800 |
| Third-party composed | `sponsors`, `dislikes`, `dearrow`, `combined` | 3600–21600 | 21600 |
| Private/ephemeral | `audio` (signed URLs), `quota` | `private, no-store` | — |

> Paginated exception: `videos/:id/related` and `videos/:id/comments` send
> `private, no-store` whenever the response carries a cursor (`page.next !=
> null`) or the request presented `?cursor=` — cursors are process-local, so a
> CDN-cached cursor page would break paging on replay. Exhausted first pages
> (`next == null`, no cursor) keep their public TTLs.

## Serve-stale-on-error rule

1. Cache-first: serve L1/L0 hit with `meta.cached: true`.
2. Revalidate in background (SWR); never block the user on upstream.
3. Upstream 403/429/5xx with a stale copy → return stale + `warnings` entry.
4. Cold miss + upstream failure → typed error with `code` + `hint`, never bare 500.
5. Transcripts must always follow 1–4: **never live-only** (Phase 2 exit gate).
