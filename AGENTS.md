<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# TubeLens AGENTS.md

API-first YouTube data API: **Next.js App Router Route Handlers + youtubei.ts on Vercel, $0 spend**.

## Project map

- `src/app/api/v1/` — all endpoints (Route Handlers only, no pages per phase).
- `src/lib/youtube.ts` — youtubei.ts **singleton, `import "server-only"`**; never instantiate per request.
- `src/lib/{envelope,cache,errors}.ts` — shared envelope, cache headers, typed errors.
- `plans/API_ROADMAP.md` — **owner-only single source of truth** (10 phases, 38 endpoints); `plans/DX_PRINCIPLES.md` (envelope, cursor, error+hint); `plans/CACHING.md` (L0/L1/L2 ladder + TTLs).
- `docs/*.mdx` — **public developer docs** (Fumadocs/MDX); docs bot owns `docs/**` + `openapi.json`, never `plans/`.

## Commands

- `bun run lint` (`biome check`) — must pass. `bun run build` — must pass. `bun test` — must pass. `npx tsc --noEmit` — must pass.
- NEVER run a local dev server (`bun run dev`) for e2e. Real e2e happens only on the GitHub Action: the e2e bot starts the dev server on the PR, tests all routes, and comments on the PR (see `AGENTS.E2E.md`).

## WORKFLOW (core)

Every phase follows this lifecycle. `plans/API_ROADMAP.md` is the single source of truth — never start a phase until it accurately describes what is to be built; keep code, tests, and docs in sync.

1. **Plan** — read the phase in `plans/API_ROADMAP.md`; update it first if unclear/outdated, then implement.
2. **Code** — implement only the current phase. Ship tests in the same change (core behavior, edge cases, error conditions, envelope, cursor, cache headers).
3. **Validation gates** — `bun run lint` + `npx tsc --noEmit` + `bun test` must all pass.
4. **Review subagents** — launch a review pass for bugs, incorrect behavior, missing edge cases, reliability, complexity, error handling (bare 500s, missing hints), envelope/cursor/header drift, missing tests, regressions.
5. **Fix** — fix genuine issues only; judge each finding, keep fixes simple, re-run validation gates.
6. **PR creation** — ALWAYS load skill `commit-pr-writing` before any commit/PR/push, then: one branch per phase → commit implementation + tests → push → create PR (one coherent phase per PR).
7. **Wait 10 minutes** for GitHub bots / automated reviewers (including the e2e bot) to comment.
8. **Fix bot findings** — fix genuine issues, ignore incorrect/irrelevant feedback, keep it simple; re-run validation gates and let CI re-verify.

A phase is done only when implementation, tests, docs, PR, and bot feedback all agree.

## Code style rules

Simple over clever; small abstractions; no paid infra; `limit` default 20/max 50, `region` US, `lang` en; cursor pagination (`?cursor=&limit=`), opaque cursors, empty page = `data: []` + `next: null` (never 404); every response carries `X-Request-Id` (+ `meta.requestId`) and `X-RateLimit-*`; 429s include `Retry-After` + `code: rate_limited`.

## API route checklist (every route)

1. `export const runtime = "nodejs"` (Innertube needs Node, never edge).
2. Validate query/path with zod; failures → 400 `{ error: { code, message, hint, status } }`.
3. Upstream call wrapped in 8s fail-fast (`AbortSignal.timeout(8000)`).
4. Set `Cache-Control` per `plans/CACHING.md` TTL table; stale responses set `meta.cached: true` + `warnings[]`.
5. Success shape `{ data, page: { next }, meta, warnings }`; errors use code + one-sentence `hint`, never stack traces.

## Quality gates (per phase)

Validation gates clean → review pass → genuine fixes → PR (one branch per phase) → 10-min bot window → fix + re-verify. Never let code, tests, `plans/`, and `docs/` drift.

### Review gate checklist

Review must check: bugs, incorrect behavior, missing edge cases, reliability problems, overly complex implementation, incorrect error handling (bare 500s, missing hints), UX/DX inconsistencies (envelope, cursor, header drift), missing or inadequate tests, regressions. Fix genuine issues only — do not blindly apply review feedback; judge whether each finding is actually valid, keep the fix simple, then re-run validation gates.

## Deployment checklist

One branch per phase → PR → Vercel preview → curl every new endpoint on the preview URL (envelope, cache headers, error+hints) → review preview/bot feedback, fix genuine issues only, re-verify gates → check 7-day health/p95 only for Phase 1 exit → merge → prod → re-verify `/api/v1/health` + one route per phase on prod. A phase is done only when code, tests, docs, and preview verification all agree.

## Verification steps (no local e2e)

1. `bun run lint` + `npx tsc --noEmit` + `bun test` pass.
2. `openapi.json` lists the new endpoints and lints clean.
3. Route e2e is owned by the GitHub Action e2e bot on the PR/preview (see `AGENTS.E2E.md`) — do not substitute local dev-server curl.

## Core rule

**Plan first. Build simply. Degrade gracefully. Verify via gates + CI e2e. Keep docs, code, and tests in sync.**
