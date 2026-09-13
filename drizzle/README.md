# drizzle/ — Neon Postgres schema + migrations (Phase 00)

- `schema.ts` — intentionally table-free placeholder. Later phases add
  tables here without reworking connection, client, or env plumbing.
  Postgres is not a cache: keep large derived payload caches out of here
  (CDN + in-memory default per `plans/PLAN.md` Phase 00).
- `migrations/` — canonical `drizzle-kit generate` output for the empty
  schema (`0 tables, nothing to migrate`): a journal with `entries: []`,
  no snapshot, no `.sql`. `bun run db:migrate` against it is a clean no-op.
- Workflow for the first real table: add it to `schema.ts`, run
  `bun run db:generate` (requires `DATABASE_DIRECT_URL` per
  `drizzle.config.ts`), review the diff, then `bun run db:migrate`
  against a preview/dev branch before prod. Migrations are forward-only.
