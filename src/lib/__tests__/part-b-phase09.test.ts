import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import {
  GET as notFoundGET,
  PUT as notFoundPUT,
} from "../../app/api/v1/[[...notFound]]/route";
import { handleTierPatch } from "../../app/api/v1/admin/users/[userId]/tier/route";
import { handleMe } from "../../app/api/v1/me/route";
import { GET as openapiGET } from "../../app/api/v1/openapi.json/route";
import { handleSearch } from "../../app/api/v1/search/route";
import {
  type AudioDeps,
  type AudioFormatInfo,
  type ByteRange,
  clearAudioBlockedForTests,
  handleAudio,
} from "../audio";
import {
  anonymousAuthContext,
  forbiddenResponse,
  requireAuth,
  unauthenticatedResponse,
} from "../auth";
import { toAuthorizationResponse } from "../authorize";
import { clearCache } from "../cache";
import type { ContinuationSearch } from "../continuations";
import { successResponse } from "../envelope";
import { errorResponse } from "../errors";
import {
  ALLOW_HEADERS,
  ALLOW_METHODS,
  applyCorsHeaders,
  applySecurityHeaders,
  corsHeaders,
  handlePreflight,
  isApiPath,
  securityHeaders,
  shouldPreflightRequest,
} from "../http-headers";
import { withRequestContext } from "../pipeline";
import { type ChannelRssDeps, handleChannelRss } from "../utils";

const SECURITY_NAMES = [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Content-Security-Policy",
  "Strict-Transport-Security",
] as const;

const EXPECTED: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

function expectSecurityHeaders(res: Response): void {
  for (const name of SECURITY_NAMES) {
    expect(res.headers.get(name)).toBe(EXPECTED[name]);
  }
}

function req(
  url = "http://localhost/api/v1/x",
  origin?: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
  if (origin !== undefined) {
    headers.set("origin", origin);
  }
  return new NextRequest(url, { headers });
}

const CORS_ENV = {
  TUBELENS_ALLOWED_ORIGINS:
    "https://app.example.com, https://other.example.test ",
};

/** Run fn with the fixture allowlist installed (restored afterwards). */
async function withCorsEnv<T>(fn: () => T): Promise<Awaited<T>> {
  const saved = process.env.TUBELENS_ALLOWED_ORIGINS;
  process.env.TUBELENS_ALLOWED_ORIGINS = CORS_ENV.TUBELENS_ALLOWED_ORIGINS;
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.TUBELENS_ALLOWED_ORIGINS;
    } else {
      process.env.TUBELENS_ALLOWED_ORIGINS = saved;
    }
  }
}

// Audio tests need the flag + secret; saved/restored per test so the suite
// never leaks env into neighboring files (bun runs files in isolation, but
// order within this file still matters).
const savedAudioEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedAudioEnv.enabled = process.env.TUBELENS_AUDIO_ENABLED;
  savedAudioEnv.secret = process.env.TUBELENS_AUDIO_SECRET;
  savedAudioEnv.blocked = process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  clearAudioBlockedForTests();
});

afterEach(() => {
  if (savedAudioEnv.enabled === undefined) {
    delete process.env.TUBELENS_AUDIO_ENABLED;
  } else {
    process.env.TUBELENS_AUDIO_ENABLED = savedAudioEnv.enabled;
  }
  if (savedAudioEnv.secret === undefined) {
    delete process.env.TUBELENS_AUDIO_SECRET;
  } else {
    process.env.TUBELENS_AUDIO_SECRET = savedAudioEnv.secret;
  }
  if (savedAudioEnv.blocked === undefined) {
    delete process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  } else {
    process.env.TUBELENS_AUDIO_BLOCKED_IDS = savedAudioEnv.blocked;
  }
  clearAudioBlockedForTests();
});

describe("security headers", () => {
  test("securityHeaders() returns the full baseline", () => {
    expect(securityHeaders()).toEqual(EXPECTED);
  });

  test("applySecurityHeaders() stamps without touching other headers", () => {
    const headers = new Headers({ "X-Request-Id": "r1", "Content-Type": "x" });
    applySecurityHeaders(headers);
    expect(headers.get("X-Request-Id")).toBe("r1");
    expect(headers.get("Content-Type")).toBe("x");
    for (const name of SECURITY_NAMES) {
      expect(headers.get(name)).toBe(EXPECTED[name]);
    }
  });

  test("success response carries all security headers", () => {
    expectSecurityHeaders(successResponse({ ok: true }, { requestId: "r1" }));
  });

  test("error responses (400/404/500/429) carry them too", () => {
    for (const status of [400, 404, 500, 429]) {
      const res = errorResponse("r1", {
        code: "x",
        message: "m",
        hint: "Do y.",
        status,
      });
      expectSecurityHeaders(res);
    }
  });

  test("429 keeps Retry-After alongside security headers", () => {
    const res = errorResponse("r1", {
      code: "rate_limited",
      message: "Rate limit exceeded.",
      hint: "Slow down and retry after the time in Retry-After.",
      status: 429,
    });
    expect(res.headers.get("Retry-After")).toBe("60");
    expectSecurityHeaders(res);
  });

  test("raw openapi.json response carries security headers", async () => {
    const res = await openapiGET(req("http://localhost/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  test("raw RSS response carries security headers", async () => {
    clearCache();
    const res = await handleChannelRss(
      req(`http://x/api/v1/channels/${RSS_UC}/rss`),
      RSS_UC,
      rssDeps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expectSecurityHeaders(res);
  });

  test("audio 206 bytes response carries security headers", async () => {
    const { deps, vid } = audioFixture();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${vid}/audio`),
      vid,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(
      req(url, undefined, { Range: "bytes=0-99" }),
      vid,
      deps,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expectSecurityHeaders(res);
  });

  test("audio 416 response carries security + range headers", async () => {
    const { deps, vid } = audioFixture();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${vid}/audio`),
      vid,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(
      req(url, undefined, { Range: "bytes=5000-6000" }),
      vid,
      deps,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_range");
  });

  test("pipeline-caught handler throw stays JSON 500 with security headers", async () => {
    const run = withRequestContext(async () => {
      throw new Error("boom");
    });
    const res = await run(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
  });

  test("pipeline stamps security headers onto raw handler responses", async () => {
    const run = withRequestContext(async () =>
      NextResponse.json({ raw: true }),
    );
    const res = await run(req());
    expectSecurityHeaders(res);
  });

  test("pipeline 429 carries decision rate-limit headers + Retry-After + security", async () => {
    const run = withRequestContext(
      async () => NextResponse.json({ ok: true }),
      {
        rateLimit: {
          check: () => ({
            allowed: false,
            limit: 10,
            remaining: 0,
            reset: 12345,
            retryAfter: 30,
          }),
        },
      },
    );
    const res = await run(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("12345");
    expect(res.headers.get("Retry-After")).toBe("30");
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
  });
});

describe("CORS discipline", () => {
  test("no Origin → no CORS headers", () => {
    expect(corsHeaders(null, CORS_ENV)).toEqual({});
  });

  test("allowed origin echoed + Vary + methods/headers/max-age, never *", () => {
    const headers = corsHeaders("https://app.example.com", CORS_ENV);
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://app.example.com",
    );
    expect(headers.Vary).toBe("Origin");
    expect(headers["Access-Control-Allow-Methods"]).toBe(ALLOW_METHODS);
    expect(headers["Access-Control-Allow-Headers"]).toBe(ALLOW_HEADERS);
    expect(headers["Access-Control-Max-Age"]).toBe("600");
    expect(Object.values(headers).some((v) => v.includes("*"))).toBe(false);
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  test("method/header sets cover all served verbs incl. Range for audio", () => {
    expect(ALLOW_METHODS).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(ALLOW_HEADERS).toContain("Range");
    expect(ALLOW_HEADERS).toContain("Authorization");
  });

  test("allowlist entries are trimmed (trailing space in env still matches)", () => {
    const headers = corsHeaders("https://other.example.test", CORS_ENV);
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://other.example.test",
    );
  });

  test("disallowed origin gets Vary but no Allow-Origin", () => {
    expect(corsHeaders("https://evil.example.com", CORS_ENV)).toEqual({
      Vary: "Origin",
    });
  });

  test("empty allowlist (default) grants nothing but still varies", () => {
    expect(corsHeaders("https://app.example.com", {})).toEqual({
      Vary: "Origin",
    });
  });

  test("applyCorsHeaders merges Vary instead of clobbering", () => {
    const headers = new Headers({ Vary: "Accept-Encoding" });
    applyCorsHeaders(headers, "https://app.example.com", CORS_ENV);
    expect(headers.get("Vary")).toBe("Accept-Encoding, Origin");
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    // Double-apply never duplicates the token.
    applyCorsHeaders(headers, "https://app.example.com", CORS_ENV);
    expect(headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });

  test("success envelope with allowlisted origin carries the grant", () => {
    const saved = process.env.TUBELENS_ALLOWED_ORIGINS;
    process.env.TUBELENS_ALLOWED_ORIGINS = CORS_ENV.TUBELENS_ALLOWED_ORIGINS;
    try {
      const res = successResponse({ ok: true }, { requestId: "r1" });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      const granted = successResponse(
        { ok: true },
        { requestId: "r1", origin: "https://app.example.com" },
      );
      expect(granted.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(granted.headers.get("Vary")).toContain("Origin");
      expectSecurityHeaders(granted);
    } finally {
      if (saved === undefined) {
        delete process.env.TUBELENS_ALLOWED_ORIGINS;
      } else {
        process.env.TUBELENS_ALLOWED_ORIGINS = saved;
      }
    }
  });

  test("typed error with allowlisted origin carries the grant", () => {
    const saved = process.env.TUBELENS_ALLOWED_ORIGINS;
    process.env.TUBELENS_ALLOWED_ORIGINS = CORS_ENV.TUBELENS_ALLOWED_ORIGINS;
    try {
      const res = errorResponse("r1", {
        code: "invalid_limit",
        message: "Invalid limit.",
        hint: "Use an integer between 1 and 50.",
        status: 400,
        origin: "https://app.example.com",
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(res.headers.get("Vary")).toContain("Origin");
      expectSecurityHeaders(res);
    } finally {
      if (saved === undefined) {
        delete process.env.TUBELENS_ALLOWED_ORIGINS;
      } else {
        process.env.TUBELENS_ALLOWED_ORIGINS = saved;
      }
    }
  });

  test("pipeline success with allowlisted Origin (real-response CORS)", async () => {
    const saved = process.env.TUBELENS_ALLOWED_ORIGINS;
    process.env.TUBELENS_ALLOWED_ORIGINS = CORS_ENV.TUBELENS_ALLOWED_ORIGINS;
    try {
      const run = withRequestContext(async () =>
        NextResponse.json({ ok: true }),
      );
      const res = await run(
        req("http://x/api/v1/health", "https://app.example.com"),
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(res.headers.get("Vary")).toContain("Origin");
      expectSecurityHeaders(res);
    } finally {
      if (saved === undefined) {
        delete process.env.TUBELENS_ALLOWED_ORIGINS;
      } else {
        process.env.TUBELENS_ALLOWED_ORIGINS = saved;
      }
    }
  });

  test("pipeline 429 with allowlisted Origin carries the grant", async () => {
    const saved = process.env.TUBELENS_ALLOWED_ORIGINS;
    process.env.TUBELENS_ALLOWED_ORIGINS = CORS_ENV.TUBELENS_ALLOWED_ORIGINS;
    try {
      const run = withRequestContext(
        async () => NextResponse.json({ ok: true }),
        {
          rateLimit: {
            check: () => ({ allowed: false, limit: 5, remaining: 0, reset: 9 }),
          },
        },
      );
      const res = await run(
        req("http://x/api/v1/x", "https://app.example.com"),
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expectSecurityHeaders(res);
    } finally {
      if (saved === undefined) {
        delete process.env.TUBELENS_ALLOWED_ORIGINS;
      } else {
        process.env.TUBELENS_ALLOWED_ORIGINS = saved;
      }
    }
  });

  test("preflight OPTIONS: allowed origin → 204 with grant", () => {
    const res = handlePreflight(
      req("http://localhost/api/v1/search", "https://app.example.com"),
      "r1",
      CORS_ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("X-Request-Id")).toBe("r1");
    expectSecurityHeaders(res);
  });

  test("preflight OPTIONS: disallowed origin → 204 with Vary, no Allow-Origin", () => {
    const res = handlePreflight(
      req("http://localhost/api/v1/search", "https://evil.example.com"),
      "r1",
      CORS_ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
    expectSecurityHeaders(res);
  });
});

describe("central preflight gate (proxy short-circuit)", () => {
  test("isApiPath covers the root, children, and nothing else", () => {
    expect(isApiPath("/api/v1")).toBe(true);
    expect(isApiPath("/api/v1/")).toBe(true);
    expect(isApiPath("/api/v1/search")).toBe(true);
    expect(isApiPath("/api/v1/batch")).toBe(true);
    expect(isApiPath("/api/v2/search")).toBe(false);
    expect(isApiPath("/api")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });

  test("shouldPreflightRequest fires only for OPTIONS on /api/v1/*", () => {
    const options = (pathname: string) =>
      shouldPreflightRequest({
        method: "OPTIONS",
        nextUrl: { pathname },
      } as unknown as NextRequest);
    expect(options("/api/v1/search")).toBe(true);
    expect(options("/api/v1/batch")).toBe(true);
    expect(options("/api/v1")).toBe(true);
    expect(options("/api/v1/")).toBe(true);
    expect(options("/api/v1/nope/deep")).toBe(true);
    expect(
      shouldPreflightRequest({
        method: "GET",
        nextUrl: { pathname: "/api/v1/search" },
      } as unknown as NextRequest),
    ).toBe(false);
    expect(options("/api/v2/search")).toBe(false);
  });
});

describe("unknown-route JSON 404", () => {
  test("catch-all GET returns typed JSON not_found, never HTML", async () => {
    const res = await notFoundGET(req("http://localhost/api/v1/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.status).toBe(404);
    expect(typeof body.error.hint).toBe("string");
    expectSecurityHeaders(res);
  });

  test("catch-all PUT returns typed JSON not_found", async () => {
    const res = await notFoundPUT(req("http://localhost/api/v1/nope"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe("real routes are not shadowed by the catch-all", () => {
  test("openapi.json still serves 200", async () => {
    const res = await openapiGET(req("http://localhost/api/v1/openapi.json"));
    expect(res.status).toBe(200);
  });

  test("search still validates (typed 400, not a 404)", async () => {
    const res = await handleSearch(req("http://x/api/v1/search"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("missing_query");
  });
});

describe("protected endpoint errors stay machine-readable", () => {
  test("401 shape is JSON with security headers", async () => {
    const res = unauthenticatedResponse("r401");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.status).toBe(401);
    expect(body.meta.requestId).toBe("r401");
  });
});

describe("direct-invoked handlers carry the CORS grant", () => {
  test("notFound GET/PUT with allowlisted Origin → 404 + ACAO", async () => {
    await withCorsEnv(async () => {
      for (const run of [notFoundGET, notFoundPUT]) {
        const res = await run(
          req("http://localhost/api/v1/nope", "https://app.example.com"),
        );
        expect(res.status).toBe(404);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
          "https://app.example.com",
        );
        expect(res.headers.get("Vary")).toContain("Origin");
        expectSecurityHeaders(res);
        const body = await res.json();
        expect(body.error.code).toBe("not_found");
      }
    });
  });

  test("unauthenticatedResponse + requireAuth with origin → 401 + ACAO", async () => {
    await withCorsEnv(async () => {
      const res = unauthenticatedResponse("r1", "https://app.example.com");
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      const denied = requireAuth({
        auth: anonymousAuthContext,
        requestId: "r2",
        origin: "https://app.example.com",
      });
      expect(denied?.status).toBe(401);
      expect(denied?.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
    });
  });

  test("forbiddenResponse + toAuthorizationResponse with origin → ACAO", async () => {
    await withCorsEnv(async () => {
      const forbidden = forbiddenResponse(
        "r1",
        undefined,
        undefined,
        "https://app.example.com",
      );
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      const denied = toAuthorizationResponse(
        "r2",
        {
          ok: false,
          code: "forbidden",
          message: "Denied.",
          hint: "Ask an admin.",
          status: 403,
        },
        "https://app.example.com",
      );
      expect(denied?.status).toBe(403);
      expect(denied?.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expectSecurityHeaders(denied as Response);
    });
  });

  test("handleMe anonymous with origin → 401 + ACAO", async () => {
    await withCorsEnv(async () => {
      const res = handleMe(
        "r1",
        anonymousAuthContext,
        "free",
        "https://app.example.com",
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      const body = await res.json();
      expect(body.error.code).toBe("unauthenticated");
    });
  });

  test("handleTierPatch unauthenticated with origin → 401 + ACAO", async () => {
    await withCorsEnv(async () => {
      const res = await handleTierPatch(
        "r1",
        anonymousAuthContext,
        "user_abc123",
        { tier: "pro" },
        {},
        "https://app.example.com",
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expectSecurityHeaders(res);
      const body = await res.json();
      expect(body.error.code).toBe("unauthenticated");
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures (local copies of the phase9/phase10 patterns — no cross-file deps)
// ---------------------------------------------------------------------------

const RSS_UC = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

function rssDeps(overrides?: Partial<ChannelRssDeps>): ChannelRssDeps {
  return {
    resolveChannelId: async (input: string) =>
      input.startsWith("UC") ? input : RSS_UC,
    fetchChannel: async (): Promise<{
      profile: unknown;
      firstPage: ContinuationSearch;
    }> => ({
      profile: {
        header: { author: { name: "Test Channel" } },
        metadata: {},
      },
      firstPage: {
        results: [
          { type: "Video", video_id: "vid000000001", title: "First & best" },
        ],
        has_continuation: false,
        getContinuation: async () => {
          throw new Error("exhausted");
        },
      },
    }),
    ...overrides,
  };
}

function audioFixture(): { deps: AudioDeps; vid: string } {
  process.env.TUBELENS_AUDIO_ENABLED = "1";
  process.env.TUBELENS_AUDIO_SECRET = "phase09-test-secret";
  delete process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  clearAudioBlockedForTests();
  const vid = "Ph09SecHdr1";
  const total = 1000;
  const full = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    full[i] = i % 256;
  }
  const deps: AudioDeps = {
    fetchFormat: async (): Promise<AudioFormatInfo> => ({
      mimeType: "audio/webm",
      bitrate: 128000,
      contentLength: total,
    }),
    fetchRange: async (_id: string, range: ByteRange | null) => {
      const start = range?.start ?? 0;
      const end = range?.end ?? total - 1;
      return {
        bytes: full.slice(start, Math.min(end, total - 1) + 1),
        contentType: "audio/webm",
        totalLength: total,
        partial: range !== null,
      };
    },
  };
  return { deps, vid };
}
