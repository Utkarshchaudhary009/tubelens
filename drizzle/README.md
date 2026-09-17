# drizzle/ — Neon Postgres schema + migrations (Phase 00)

- `schema.ts` — Phase 14 adds the first real table, `usage_ledger`
  (durable weighted-credit rows: principal/tier/operation/cost/policy
  version/window/outcome/request id). Later phases add tables here without
  reworking connection, client, or env plumbing.
  Postgres is not a cache: keep large derived payload caches out of here
  (CDN + in-memory default per `plans/PLAN.md` Phase 00).
- `migrations/` — `drizzle-kit generate` output for the `usage_ledger`
  table (Phase 14): journal + snapshot + `.sql` creating the table with the
  `(principal, window_id)` balance index, `UNIQUE(billing_key)` charging
  idempotency, and `CHECK`s on cost/outcome. Never applied to a live
  database yet — `bun run db:migrate` still needs owner Neon credentials
  (`DATABASE_DIRECT_URL`) against a preview/dev branch first.
- Workflow for schema changes: edit `schema.ts`, run `bun run db:generate`
  (offline schema diff — works without credentials), review the diff, then
  `bun run db:migrate` (requires `DATABASE_DIRECT_URL` per
  `drizzle.config.ts`) against a preview/dev branch before prod.
  Migrations are forward-only.
