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

  test("lists exactly the 11 Phase 1+2+3 endpoints", () => {
    const doc = buildOpenApiDocument();
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual([
      "/hashtags/{tag}",
      "/health",
      "/openapi.json",
      "/resolve",
      "/search",
      "/search/suggestions",
      "/videos/{id}",
      "/videos/{id}/captions",
      "/videos/{id}/comments",
      "/videos/{id}/related",
      "/videos/{id}/transcript",
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

  test("resolve documents url/region/lang params", () => {
    const doc = buildOpenApiDocument();
    const params = doc.paths["/resolve"].get.parameters.map(
      (p: { name: string }) => p.name,
    );
    for (const name of ["url", "region", "lang"]) {
      expect(params).toContain(name);
    }
  });

  test("envelope meta requires region/lang/cached/requestId", () => {
    const doc = buildOpenApiDocument();
    const meta = doc.components.schemas.Envelope.properties.meta as {
      required: string[];
    };
    for (const name of ["region", "lang", "cached", "requestId"]) {
      expect(meta.required).toContain(name);
    }
  });

  test("error body requires error + meta (parity contract)", () => {
    const doc = buildOpenApiDocument();
    const errorBody = doc.components.schemas.ErrorBody as {
      required: string[];
    };
    expect(errorBody.required).toContain("error");
    expect(errorBody.required).toContain("meta");
  });

  test("404 descriptions document disabled/unavailable + not-found codes", () => {
    const doc = buildOpenApiDocument();
    type Paths = keyof typeof doc.paths;
    const get404 = (path: Paths) =>
      (
        doc.paths[path].get.responses as Record<string, { description: string }>
      )[404].description;
    expect(get404("/videos/{id}/comments")).toContain("comments_disabled");
    expect(get404("/videos/{id}/comments")).toContain("video_not_found");
    expect(get404("/videos/{id}/captions")).toContain("captions_disabled");
    expect(get404("/videos/{id}/captions")).toContain("video_not_found");
    expect(get404("/videos/{id}/transcript")).toContain(
      "transcript_unavailable",
    );
    expect(get404("/videos/{id}/transcript")).toContain("video_not_found");
    expect(get404("/videos/{id}/related")).toContain("video_not_found");
  });

  test("GET serves the raw spec (tooling-compatible) with headers", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/v1/openapi.json"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(body.paths)).toHaveLength(11);
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
