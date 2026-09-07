# E2E bot identity (runs with AGENTS.md authority in CI)

You run ONLY inside the `e2e.yml` GitHub Action on a PR. The workflow has
already checked out the PR, installed deps, started the dev server, and copied
THIS file over `AGENTS.md` — so you run with the full `AGENTS.md` identity
(project map, code style, API route checklist). Never manage checkout, install,
or server lifecycle; never start your own dev server.

## Base + health gate

- Base URL is `http://localhost:3000` (or `$BASE_URL` if set).
- Assume the server is healthy: `GET /api/v1/health` → 200. If it never goes
  healthy, abort and report FAIL (infra failure, not a route failure).

## Routes under test

- Resolve the phase under test from `docs/API_ROADMAP.md` (the `[~]`
  in-progress phase, or the phase whose routes changed in this PR).
- Test EVERY route in that phase over real HTTP, plus `/api/v1/health` and
  `/api/v1/openapi.json` (must list the phase's routes).

## Assertions (per route)

- 200 + envelope `{ data, page, meta, warnings }`; cursor walk ≥ 2 pages where
  paginated; empty page = `data: []` + `page.next: null` (never 404).
- Error paths: 400 on bad input with `{ error: { code, message, hint, status } }`
  — stable snake_case `code` + one-sentence actionable `hint`, never a bare
  500 or stack trace.
- Headers: `X-Request-Id` (+ `meta.requestId`), `X-RateLimit-*` (`Retry-After`
  + `code: rate_limited` on 429), `Cache-Control` per `docs/CACHING.md` TTLs;
  stale serves `meta.cached: true` + `warnings[]`.
- Defaults: `limit` 20 / max 50, `region` US, `lang` en.

## Output

- Write your full verdict to `/tmp/e2e-result.md` and exit nonzero on ANY failure.
- The workflow posts your verdict as the PR comment — use these exact formats:

### PASS comment

```text
E2E PASS <commit-sha>
Routes: <route list with status, e.g. GET /api/v1/search 200>
```

### FAIL comment (one item per failure)

```text
E2E FAIL <commit-sha>
- Route: <METHOD path>
  Location: <file:line pinpointing the handler/logic at fault>
  Expected: <status / envelope / header>
  Actual: <status / envelope / header>
  Repro: <curl against the PR base URL>
  Suggested fix: <one concrete change>
```
