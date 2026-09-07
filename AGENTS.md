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
- `docs/*.mdx` — **public developer docs** (Fumadocs/MDX); docs agent owns `docs/**`, never `plans/`.

## Commands

- `bun run lint` (`biome check`) — must pass.
- `bun run build` — must pass.
- `bun test` — must pass.
- `npx tsc --noEmit` — must pass.
- NEVER run a local dev server (`bun run dev`) for e2e. Real e2e happens only on the GitHub Action; the e2e agent starts the dev server and reports its result in the Action run summary (see `AGENTS.E2E.md`).

## WORKFLOW (core — mandatory)

`plans/API_ROADMAP.md` is the single source of truth. The following are **MUST** rules, not suggestions.

1. **One phase at a time.** Determine the first roadmap phase whose status is not `[x]`. Never skip a phase. If that phase already has an open PR, continue that PR instead of creating another.
2. **Plan first.** Read the entire current phase and its exit criteria before coding. If the phase description is stale or unclear, fix the plan before implementation. Mark a phase `[~]` only when work has actually started.
3. **Code + tests.** Implement only the current phase. Add or update tests in the same change. Do not start the next phase early.
4. **Validation gates are mandatory.** Before a PR is considered ready, `bun run lint`, `npx tsc --noEmit`, and `bun test` MUST pass. `bun run build` MUST pass before merge.
5. **Review pass is mandatory.** Run a review subagent before opening the PR. Review for bugs, incorrect behavior, missing edge cases, reliability, complexity, error handling, envelope/cursor/header drift, missing tests, and regressions. Fix genuine findings and re-run the validation gates.
6. **PR rules are mandatory.** ALWAYS load skill `commit-pr-writing` before any commit, push, or PR operation. Use one branch per phase and one coherent phase per PR.
7. **Automated verification loop.** After the PR is opened or updated, allow **up to 3 verification/review rounds**. Each round MUST wait at least 10 minutes for GitHub Actions and automated reviewers to finish, then inspect the validation and E2E workflow results/reports and any automated review findings, fix every genuine finding, push the fix, and let CI rerun. Validation and E2E report to their own Action run summaries; they do not comment on the PR.
8. **Merge gate is mandatory.** Merge the phase PR only when the latest commit has all required checks green, validation and E2E results are successful, no genuine review finding remains unresolved, the PR is mergeable, and the current phase exit criteria are satisfied. Never merge merely because the 3-round limit was reached.
9. **If still failing after 3 rounds, stop.** Do not merge. Leave the PR open with the remaining failure clearly reported. A later scheduled run must continue that existing phase/PR rather than starting a new one.
10. **Post-merge roadmap update is mandatory.** Only AFTER the phase PR has actually merged, update `plans/API_ROADMAP.md` on `main`: change that phase from `[~]` or `[ ]` to `[x]` and change its `Status` line to `**Status:** `[x]` done`. Commit and push that roadmap change. Never mark a phase `[x]` before its PR is merged.
11. **Post-merge verification is mandatory.** After the roadmap update, verify production health and the phase's relevant endpoint(s) on production as required by the deployment checklist. Never declare the phase complete before this check.
12. **Only then advance.** After the merged phase is checked `[x]` and its post-merge verification is complete, the next scheduled run may begin the next phase.

## Autonomous runner contract

The scheduled GitHub Action invokes the phase agent with one instruction: **advance the next phase**. The agent owns the engineering work and GitHub interaction required by the mandatory workflow above. The workflow should provide the machine, credentials, checkout, and OpenCode environment; it must not micromanage individual coding or testing commands.

Validation and E2E workflows are intentionally different: they run on branch pushes, use no GitHub API token, do not comment on PRs, and publish their reports only to the Action run summary. The phase runner must use their check/run results and summaries as verification evidence.

The docs-sync workflow is intentionally different: it runs on **every push to `main`**, including PR merge commits and direct pushes. It owns documentation synchronization for that main-branch change, may update only `docs/**`, and publishes its result to its Action run summary. It must not depend on a `pull_request.closed` event or PR comments.

## Code style rules

Simple over clever; small abstractions; no paid infra; `limit` default 20/max 50, `region` US, `lang` en; cursor pagination (`?cursor=&limit=`), opaque cursors, empty page = `data: []` + `next: null` (never 404); every response carries `X-Request-Id` (+ `meta.requestId`) and `X-RateLimit-*`; 429s include `Retry-After` + `code: rate_limited`.

## API route checklist (every route)

1. `export const runtime = "nodejs"` (Innertube needs Node, never edge).
2. Validate query/path with zod; failures → 400 `{ error: { code, message, hint, status } }`.
3. Upstream call wrapped in 8s fail-fast (`AbortSignal.timeout(8000)`).
4. Set `Cache-Control` per `plans/CACHING.md` TTL table; stale responses set `meta.cached: true` + `warnings[]`.
5. Success shape `{ data, page: { next }, meta, warnings }`; errors use code + one-sentence `hint`, never stack traces.

## Quality gates (per phase)

Validation gates → mandatory review pass → PR → up to 3 automated verification/review rounds → merge only on a clean merge gate → post-merge roadmap checkbox → post-merge production verification. Never let code, tests, `plans/`, and `docs/` drift.

### Review gate checklist

Review MUST check: bugs, incorrect behavior, missing edge cases, reliability problems, overly complex implementation, incorrect error handling (bare 500s, missing hints), UX/DX inconsistencies (envelope, cursor, header drift), missing or inadequate tests, regressions. Fix genuine issues only — do not blindly apply review feedback; judge whether each finding is actually valid, keep the fix simple, then re-run validation gates.

## Deployment checklist

One branch per phase → PR → Vercel preview → validation + e2e → up to 3 automated verification/review rounds → merge gate → merge → update roadmap checkbox on `main` → production health + relevant endpoint verification. Phase 1 additionally requires 7-day health/p95 validation before its phase can be declared complete.

## Verification steps (no local e2e)

1. `bun run lint` + `npx tsc --noEmit` + `bun test` pass before PR/after genuine fixes.
2. `bun run build` passes before merge.
3. `openapi.json` lists the new endpoints and lints clean.
4. Route e2e is owned by the GitHub Action e2e agent on the branch/preview (see `AGENTS.E2E.md`) and its report is published to the Action run summary — do not substitute local dev-server curl.
5. Docs synchronization runs automatically on every push to `main`; inspect the docs-sync Action summary when documentation synchronization details are needed.

## Core rule

**Plan first. Build simply. Treat workflow rules as MUST. Verify before merge, mark the roadmap only after merge, verify production, then advance exactly one phase at a time.**
