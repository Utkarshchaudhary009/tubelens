---
name: commit-pr-writing
description: Use when committing, pushing, or creating a PR — guide for writing effective commit messages and PR descriptions. Load this skill before any commit, push, or PR operation.
---

# Commit & PR Prose

Reader: one expert reviewer whose time matters more than completeness.
Length scales with **risk**, never with effort spent.
Every rule below has a name — use the names when judging text.

## The laws

### 1. Proportionality
Description size tracks risk. Mechanical change → one line. Behavioral change → reasoning.
- ✅ Regression-test-only PR: `Closes #128525`
- ❌ Nine-section essay for a template rename

### 2. Consequence over action
Say what breaks and who hits it — not what was edited.
- ✅ "Fix division by zero in tg_cpus() triggered by empty cpusets"
- ✅ "Fix get_cycles() regression causing boot hangs on ARM"
- ❌ "Update tg_cpus function"

### 3. Root-cause chain
Commit body = one paragraph: cause → fix mechanism → scope/test delta.
- ✅ "quota rebuilt auth from a stale disk snapshot, so refresh threw invalid_grant; resolve from the in-memory record first, retry once against re-resolved state (+269 lines of regression tests)"
- ❌ Bullet list restating every touched file's diff

### 4. Triage
Deciding what does NOT deserve words is the writing. Cut parallel category scaffolding (Enhancements / Bug Fixes / Docs / Tests headers) unless sections genuinely differ in weight.
- ❌ A "Documentation:" section announcing README edits inside a quota bugfix
- ✅ Fold trivia into one closing clause

### 5. One voice (anti-stacking)
**Stacking** = layering multiple machine texts that repeat each other (agent description + Sourcery + cubic = same content ×3 at three compression levels). Reviewers stop reading and read the raw diff instead, defeating the description. Suppress bot summarizers; exactly one author voice per artifact.
- ❌ PR page showing three stacked summaries
- ✅ One description, written once, by whoever owns the change

### 6. Judgment on the record
Include opinion, hedging, and cost-benefit calls. Omniscient certainty reads as untrustworthy.
- ✅ "Not worth debugging this over parallelizing it."
- ✅ "Can't reproduce locally; landing because CI is where it broke."
- ✅ "Known pre-existing failures, unrelated — fail identically on main."
- ❌ Zero hedges; everything asserted as certain

### 7. Why-now note
For risky or behavioral changes, one line on why this lands today (red CI, blocked sync, incident).
- ✅ "Landing here because rustc CI is where this used to break."

### 8. Subject discipline
Imperative mood, ≤72 chars, scope + consequence. Conventional prefixes only if the repo already uses them.
- ✅ `fix(quota): resolve token from in-memory state to avoid invalid_grant after rotation`
- ❌ `Rework Antigravity auth plugin` (vague) · `fix bugs` (empty)

## Pre-push check
1. Preview-render markdown once — escaped `\backticks\` mark machine output instantly.
2. Any bullet that could sit unchanged under any other PR? Cut it — that's failed triage.
3. Length mismatched to risk? Rewrite — that's failed proportionality.

## Repo notes (TubeLens)
- One branch per phase → one coherent phase per PR (see AGENTS.md WORKFLOW step 6).
- Commit subject: imperative, ≤72 chars; body = cause → fix → scope/test delta.
- Never pad descriptions with per-file diff restatements; reviewers read the diff.
- Route e2e evidence lives on the PR via the GitHub Action e2e bot — link it, don't duplicate it.
