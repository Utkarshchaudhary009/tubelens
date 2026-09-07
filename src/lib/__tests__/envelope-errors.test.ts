import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { getRequestId, successResponse } from "../envelope";
import { errorResponse } from "../errors";

function reqWithId(id?: string): NextRequest {
  const headers = new Headers();
  if (id) {
    headers.set("x-request-id", id);
  }
  return new NextRequest("http://localhost/api/v1/x", { headers });
}

describe("success envelope", () => {
  test("shape: { data, page.next, meta, warnings }", async () => {
    const res = successResponse([{ a: 1 }], {
      requestId: "r1",
      next: "cursor1",
    });
    const body = await res.json();
    expect(body.data).toEqual([{ a: 1 }]);
    expect(body.page).toEqual({ next: "cursor1" });
    expect(body.meta.region).toBe("US");
    expect(body.meta.cached).toBe(false);
    expect(body.meta.requestId).toBe("r1");
    expect(body.warnings).toEqual([]);
  });

  test("empty page uses next: null", async () => {
    const res = successResponse([], { requestId: "r1" });
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });

  test("carries X-Request-Id + X-RateLimit-* headers", () => {
    const res = successResponse({}, { requestId: "r2" });
    expect(res.headers.get("X-Request-Id")).toBe("r2");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
  });

  test("cached + warnings propagate", async () => {
    const res = successResponse(
      {},
      { requestId: "r1", cached: true, warnings: ["stale"] },
    );
    const body = await res.json();
    expect(body.meta.cached).toBe(true);
    expect(body.warnings).toEqual([{ message: "stale" }]);
  });
});

describe("typed errors", () => {
  test("shape: { error: { code, message, hint, status } } + status", async () => {
    const res = errorResponse("r9", {
      code: "video_not_found",
      message: "Video not found or unavailable.",
      hint: "Check the video id.",
      status: 404,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "video_not_found",
        message: "Video not found or unavailable.",
        hint: "Check the video id.",
        status: 404,
      },
    });
  });

  test("errors also carry tracing headers", () => {
    const res = errorResponse("r9", {
      code: "missing_query",
      message: "q required",
      hint: "Add ?q=.",
      status: 400,
    });
    expect(res.headers.get("X-Request-Id")).toBe("r9");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  test("retryAfter sets Retry-After header", () => {
    const res = errorResponse("r9", {
      code: "rate_limited",
      message: "Over limit.",
      hint: "Retry after 30 seconds.",
      status: 429,
      retryAfter: 30,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

describe("getRequestId", () => {
  test("echoes caller value", () => {
    expect(getRequestId(reqWithId("caller-123"))).toBe("caller-123");
  });

  test("mints a uuid when absent", () => {
    const id = getRequestId(reqWithId());
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
