import { type NextRequest, NextResponse } from "next/server";
import { baseHeaders, CACHE_CONTROL, getRequestId } from "@/lib/envelope";

export const runtime = "nodejs";

// OpenAPI 3.1 stub for Phase 2: documents exactly the 9 shipped endpoints.
// Grows each phase; promoted to the full spec in Phase 10. Exported as a
// pure builder so tests can validate it without HTTP.
export function buildOpenApiDocument() {
  const envelopeRef = "#/components/schemas/Envelope";
  const errorRef = "#/components/schemas/ErrorBody";
  return {
    openapi: "3.1.0",
    info: {
      title: "TubeLens API",
      // Single service version: keep in sync with /health data.version and
      // package.json (0.1.0 until the v1 API is declared stable).
      version: "0.1.0",
      description:
        "API-first YouTube data API. Phase 2 ships watch essentials: related rail, comments, captions, and transcript, plus Phase 1 health, search, video details, URL resolving, and this spec.",
    },
    servers: [{ url: "https://tubelens.vercel.app/api/v1" }],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness + YouTube session status",
          responses: {
            200: {
              description:
                "Service is alive; session may be ready or degraded.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
          },
        },
      },
      "/search": {
        get: {
          operationId: "search",
          summary: "Unified search across videos, channels, and playlists",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "type",
              in: "query",
              schema: {
                type: "string",
                enum: ["video", "channel", "playlist", "all"],
                default: "all",
              },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
              description:
                "Echo-only: the upstream session is fixed to US/en by the zero-cost shared-session design (single shared session), so region only affects meta and CDN cache variance.",
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
              description:
                "Echo-only: the upstream session is fixed to US/en by the zero-cost shared-session design (single shared session), so lang only affects meta and CDN cache variance.",
            },
          ],
          responses: {
            200: {
              description:
                "Paged search results. meta.cached reflects the origin L0 only — CDN L1 hits replay the stored JSON verbatim (including its meta).",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "missing_query, invalid_type, or invalid_limit.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/videos/{id}": {
        get: {
          operationId: "getVideo",
          summary: "Canonical video detail and metadata",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
            },
          ],
          responses: {
            200: {
              description: "Video metadata.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "invalid_video_id.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            404: {
              description: "video_not_found.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed (e.g. bot-guard). Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/videos/{id}/related": {
        get: {
          operationId: "getRelated",
          summary: "Up-next / related videos rail",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
            },
          ],
          responses: {
            200: {
              description: "Paged related videos.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "invalid_video_id or invalid_limit.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            404: {
              description: "video_not_found.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/videos/{id}/comments": {
        get: {
          operationId: "getComments",
          summary: "Top-level comments with continuation pagination",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
            },
          ],
          responses: {
            200: {
              description: "Paged top-level comments.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "invalid_video_id or invalid_limit.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            404: {
              description: "video_not_found.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/videos/{id}/captions": {
        get: {
          operationId: "getCaptions",
          summary: "List available caption tracks and languages",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
            },
          ],
          responses: {
            200: {
              description: "Caption track list.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "invalid_video_id.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            404: {
              description: "captions_disabled or video_not_found.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/videos/{id}/transcript": {
        get: {
          operationId: "getTranscript",
          summary: "Timed transcript text for reading and search",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
            },
          ],
          responses: {
            200: {
              description: "Timed transcript segments.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "invalid_video_id.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            404: {
              description: "transcript_unavailable or video_not_found.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; YouTube Innertube call failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            504: {
              description:
                "upstream_timeout; the 8s fail-fast fired. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/resolve": {
        get: {
          operationId: "resolveUrl",
          summary: "Resolve any YouTube URL to { type, id }",
          parameters: [
            {
              name: "url",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "region",
              in: "query",
              schema: { type: "string", default: "US" },
              description: "Echo-only request context, mirrored in meta.",
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", default: "en" },
              description: "Echo-only request context, mirrored in meta.",
            },
          ],
          responses: {
            200: {
              description: "Resolved type + id.",
              content: {
                "application/json": { schema: { $ref: envelopeRef } },
              },
            },
            400: {
              description: "missing_url or unresolvable_url.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            429: {
              description:
                "rate_limited; retry after the Retry-After seconds. X-RateLimit-* headers are present on every response.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
            502: {
              description:
                "upstream_degraded; URL resolution failed. Retry shortly.",
              content: { "application/json": { schema: { $ref: errorRef } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          summary: "This spec stub",
          responses: {
            200: {
              description: "OpenAPI 3.1 document.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Envelope: {
          type: "object",
          required: ["data", "page", "meta", "warnings"],
          properties: {
            data: {},
            page: {
              type: "object",
              required: ["next"],
              properties: { next: { type: ["string", "null"] } },
            },
            meta: {
              type: "object",
              required: ["region", "lang", "cached", "requestId"],
              properties: {
                region: { type: "string" },
                lang: { type: "string" },
                cached: {
                  type: "boolean",
                  description:
                    "True when served from the origin L0 cache (fresh or stale). CDN L1 hits replay stored JSON verbatim, so a replayed true does not mean the CDN revalidated.",
                },
                requestId: {
                  type: "string",
                  description:
                    "Mirrors the X-Request-Id response header. CDN L1 replays the origin requestId verbatim.",
                },
              },
            },
            warnings: { type: "array", items: { type: "object" } },
          },
        },
        ErrorBody: {
          type: "object",
          required: ["error", "meta"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "hint", "status"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                hint: { type: "string" },
                status: { type: "integer" },
              },
            },
            meta: {
              type: "object",
              required: ["requestId"],
              properties: {
                requestId: {
                  type: "string",
                  description: "Mirrors the X-Request-Id response header.",
                },
              },
            },
          },
        },
      },
    },
  };
}

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  // Served RAW (not inside the success envelope) so OpenAPI tooling can
  // consume the URL directly. Tracing/rate-limit/cache headers still apply.
  // X-Request-Id-only exception: with no envelope there is no meta.requestId,
  // so correlate via the X-Request-Id response header (echoed or minted).
  const headers = baseHeaders(requestId);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", CACHE_CONTROL.openapi);
  return new NextResponse(JSON.stringify(buildOpenApiDocument()), {
    status: 200,
    headers,
  });
}
