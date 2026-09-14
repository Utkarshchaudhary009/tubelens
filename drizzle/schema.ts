// Phase 00 placeholder schema — intentionally no tables yet.
//
// Later phases add tables/migrations without reworking connection, client,
// or env plumbing. Postgres is not a cache: keep large derived payload
// caches out of here (CDN + in-memory default per plans/PLAN.md Phase 00).
export {};
