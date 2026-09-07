import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { buildOpenApiDocument, GET } from "../../app/api/v1/openapi.json/route";
import { GET as resolveGET } from "../../app/api/v1/resolve/route";

describe("openapi stub", () => {
  test("has required openapi/info/paths fields", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe("TubeLens API");
    expect(typeof doc.info.version).toBe("string");
    expect(typeof doc.paths).toBe("object");
  });

  test("lists exactly the 5 Phase 1 endpoints", () => {
    const doc = buildOpenApiDocument();
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual([
      "/health",
      "/openapi.json",
      "/resolve",
      "/search",
      "/videos/{id}",
    ]);
  });

  test("search documents q/type/limit/cursor params", () => {
    const doc = buildOpenApiDocument();
    const params = doc.paths["/search"].get.parameters.map(
      (p: { name: string }) => p.name,
    );
    for (const name of ["q", "type", "limit", "cursor"]) {
      expect(params).toContain(name);
    }
  });

  test("envelope + error schemas present with required fields", () => {
    const doc = buildOpenApiDocument();
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[] }
    >;
    for (const name of ["Envelope", "ErrorBody"]) {
      expect(Object.keys(schemas)).toContain(name);
    }
    expect(schemas.Envelope.required).toContain("data");
    expect(schemas.ErrorBody.required).toContain("error");
  });

  test("GET serves the raw spec (tooling-compatible) with headers", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/v1/openapi.json"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(body.paths)).toHaveLength(5);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });
});

describe("resolve handler", () => {
  test("short URL resolves with envelope + headers", async () => {
    const res = await resolveGET(
      new NextRequest(
        "http://localhost/api/v1/resolve?url=https://youtu.be/dQw4w9WgXcQ",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ type: "video", id: "dQw4w9WgXcQ" });
    expect(body.page).toEqual({ next: null });
    expect(body.meta.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  test("missing url -> 400 missing_url shape", async () => {
    const res = await resolveGET(
      new NextRequest("http://localhost/api/v1/resolve"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("missing_url");
    expect(typeof body.error.hint).toBe("string");
    expect(body.error.status).toBe(400);
  });

  test("garbage url -> 400 unresolvable_url shape", async () => {
    const res = await resolveGET(
      new NextRequest(
        "http://localhost/api/v1/resolve?url=https://example.com/nope",
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unresolvable_url");
    expect(typeof body.error.hint).toBe("string");
  });
});
