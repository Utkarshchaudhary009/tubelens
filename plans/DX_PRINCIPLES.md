# TubeLens DX Principles

Short contract every `/api/v1` endpoint follows. Details live here so the
roadmap stays lean.

## REST conventions

- Resource nouns, plurals for collections: `/videos`, `/channels/:id/videos`.
- Sub-resources for scoped reads: `/videos/:id/comments`, `/videos/:id/audio`.
- Filtering, sorting, and geo via query params: `?region=US&type=video&sort=newest`.
- `GET` reads are safe and cacheable; only `/batch` uses `POST` (request body
  carries the sub-request list).
- Identifiers are raw YouTube IDs in the path; full URLs go to `/resolve` first.

## Defaults

- `limit` defaults to `20`, max `50` unless an endpoint documents otherwise.
- `region` defaults to `US`; `lang` defaults to `en`.
- JSON everywhere; UTF-8; ISO-8601 timestamps; durations in seconds.

## Envelope

Every success response uses one envelope:

```json
{
  "data": {},
  "page": { "next": "opaque-cursor-or-null" },
  "meta": { "region": "US", "cached": false },
  "warnings": []
}
```

- `page.next`: opaque continuation cursor; `null` means end of list.
- `meta`: request context (region, cache hit, timings).
- `warnings`: non-fatal notes (e.g. a degraded third-party source in `combined`).

## Pagination

- Cursor-based with `?cursor=` + `?limit=`; never page numbers.
- Cursors are opaque strings — clients must not parse them.
- Empty pages return `"data": []` with `"page": { "next": null }`, never 404.

## Error-with-hint format

Every error returns a machine-readable `code` plus a human `hint` telling the
caller what to do next:

```json
{
  "error": {
    "code": "captions_disabled",
    "message": "This video has no caption tracks.",
    "hint": "Hide the transcript panel or fall back to /videos/:id.",
    "status": 404
  }
}
```

- `code`: stable snake_case string safe to branch on.
- `hint`: one actionable sentence, not a stack trace.
- 4xx for caller-fixable problems, 5xx only when our side failed.

## Rate limiting & tracing

- Over-limit reads return `429` with a `Retry-After` header (seconds) and an
  error body with `code: "rate_limited"` plus a `hint` stating when to retry.
- Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
  `X-RateLimit-Reset` (unix seconds); clients should back off before hitting zero.
- Every response carries an `X-Request-Id` header, echoed back if the caller
  sends one; include it in bug reports. It also appears as `meta.requestId`.

## Versioning

- Path versioning: `/api/v1/...`. Breaking changes ship as `/api/v2`.
- Additive changes (new fields, new optional params) never bump the version.
- Deprecated fields are marked in `openapi.json` and kept for ≥ 90 days.
