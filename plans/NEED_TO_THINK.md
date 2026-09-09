# TubeLens — Need to Think (great-risk / aggressive-infra gates)

$0-spend lens: default is CDN + in-memory. Anything below needs its phase gate
cleared before adding infra or shipping. Read with `plans/PLAN.md` + `plans/CACHING.md`.

## 1. Transcript hardening (Phase 2)
- **Why risky:** YouTube hardens caption/transcript access (auth walls, 403/429,
  format churn); a live-only endpoint breaks without warning.
- **Cheap mitigation:** Aggressive-cache (`s-maxage=86400` + SWR), serve
  stale-on-error with `meta.cached: true` + `warnings`; OPTIONAL free-tier
  persist (Neon/R2/Upstash) only at its phase.
- **Decide at:** Phase 2 exit — must demo stale-on-error before Phase 3.

## 2. Streaming URLs / PO tokens + ToS (Phase 9)
- **Why risky:** Deciphering player responses and Proof-of-Origin tokens is a
  cat-and-mouse game; proxying bytes risks ToS violation and takedown.
- **Cheap mitigation:** Never expose raw upstream URLs; signed expiring URLs,
  Range-gateway, flag-gated route, per-video kill switch.
- **Decide at:** Phase 9 gate — post-v1 legal review required before enabling.

## 3. IP rate-limit / bans on Vercel (all phases)
- **Why risky:** Shared Vercel egress IPs get throttled/banned by YouTube,
  taking down all routes at once.
- **Cheap mitigation:** CDN-first (absorb repeats), short TTLs on hot routes,
  backoff + `429`/`Retry-After`, `quota` endpoint for visibility.
- **Decide at:** Phase 1 exit (7-day green + p95 checks); revisit each phase.

## 4. Auth writes — likes, subscribes, playlists (out of v1 scope)
- **Why risky:** OAuth writes need per-user tokens, session storage, and abuse
  handling — breaks the stateless $0 model.
- **Cheap mitigation:** Stay read-only in v1; if ever needed, free-tier
  Upstash session store, marked OPTIONAL.
- **Decide at:** Post-v1 — never pull into Phases 1–10 without a new gate.

## 5. SponsorBlock / Dislikes / DeArrow dependency (Phase 8)
- **Why risky:** Third-party crowd-sourced APIs change, throttle, or die;
  one outage must not cascade.
- **Cheap mitigation:** Independent degradation (partial `data` + `warnings`,
  never 500), separate TTLs, `combined` composes cached parts only.
- **Decide at:** Phase 8 entry — each source needs a fallback contract first.

## 6. Audio proxy legal risk (Phase 9)
- **Why risky:** Serving audio bytes invites copyright/takedown exposure even
  with Range-gatewaying.
- **Cheap mitigation:** Flag-gated, expiring links, takedown signal disables
  per-video within 1h with typed `hint`; no re-serve after takedown.
- **Decide at:** Phase 9 gate — legal review + abuse path demoed before Phase 10.

## 7. Long-tail Workflow / Queues cost (Phase 10)
- **Why risky:** Background refresh (playlists, feeds, `batch`) tempts paid
  queues/cron/workers that violate $0.
- **Cheap mitigation:** Lazy refresh on read + CDN SWR; Vercel free cron only
  if unavoidable and marked OPTIONAL.
- **Decide at:** Phase 10 entry — prove read-path SWR suffices before any queue.
