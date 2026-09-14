import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  handleTunnelGet,
  handleTunnelWrite,
  isAuthorized,
  parseStoredTunnel,
  type TunnelDeps,
  type TunnelRecord,
  type TunnelSlot,
  tunnelBlobPath,
  tunnelSlotSchema,
  tunnelUrlBodySchema,
} from "../tunnel-url";

const URL = "https://bright-fox-123.trycloudflare.com";

function req(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", "tunnel-test");
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body,
    headers,
  });
}

function writeReq(
  body: unknown,
  auth?: string,
  rawBody?: string,
  query = "",
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth !== undefined) {
    headers.authorization = auth;
  }
  return req(`http://localhost/api/v1/tunnel-url${query}`, {
    method: "POST",
    body: rawBody ?? JSON.stringify(body),
    headers,
  });
}

function deps(overrides?: Partial<TunnelDeps>): TunnelDeps {
  return {
    store: {
      read: async (_slot: TunnelSlot) => null,
      write: async (_slot: TunnelSlot, rec) => rec,
    },
    expectedToken: "secret-token",
    ...overrides,
  };
}

describe("tunnel slots", () => {
  test("only t3 and transcript are valid", () => {
    expect(tunnelSlotSchema.safeParse("t3").success).toBe(true);
    expect(tunnelSlotSchema.safeParse("transcript").success).toBe(true);
    expect(tunnelSlotSchema.safeParse("").success).toBe(false);
    expect(tunnelSlotSchema.safeParse("tts").success).toBe(false);
    expect(tunnelSlotSchema.safeParse(undefined).success).toBe(false);
  });

  test("each slot maps to its own blob path", () => {
    expect(tunnelBlobPath("t3")).toBe("tunnel-url-t3.json");
    expect(tunnelBlobPath("transcript")).toBe("tunnel-url-transcript.json");
  });
});

describe("tunnelUrlBodySchema", () => {
  test("accepts a trycloudflare https URL with optional path", () => {
    expect(
      tunnelUrlBodySchema.safeParse({ name: "t3", url: URL, runId: "123" })
        .success,
    ).toBe(true);
    expect(
      tunnelUrlBodySchema.safeParse({
        name: "transcript",
        url: `${URL}/speak/hello`,
      }).success,
    ).toBe(true);
  });

  test("requires a valid name slot", () => {
    expect(tunnelUrlBodySchema.safeParse({ url: URL }).success).toBe(false);
    expect(
      tunnelUrlBodySchema.safeParse({ name: "nope", url: URL }).success,
    ).toBe(false);
  });

  test("rejects non-tunnel URLs", () => {
    for (const url of [
      "",
      "http://abc.trycloudflare.com",
      "https://example.com",
      "https://trycloudflare.com.evil.com",
      "https://abc.trycloudflare.com.evil.com",
      "not a url",
    ]) {
      expect(tunnelUrlBodySchema.safeParse({ name: "t3", url }).success).toBe(
        false,
      );
    }
  });
});

describe("isAuthorized", () => {
  test("accepts the exact bearer token", () => {
    expect(isAuthorized("Bearer secret-token", "secret-token")).toBe(true);
  });

  test("rejects missing, malformed, or wrong credentials", () => {
    expect(isAuthorized(null, "secret-token")).toBe(false);
    expect(isAuthorized("Bearer wrong", "secret-token")).toBe(false);
    expect(isAuthorized("Basic secret-token", "secret-token")).toBe(false);
    expect(isAuthorized("Bearer secret-token", undefined)).toBe(false);
    expect(isAuthorized("Bearer ", "secret-token")).toBe(false);
  });
});

describe("handleTunnelWrite", () => {
  test("401 without a bearer token (envelope: code + hint + request id)", async () => {
    const res = await handleTunnelWrite(writeReq({ url: URL }), deps());
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBe("tunnel-test");
    const body = (await res.json()) as {
      error: { code: string; hint: string; status: number };
      meta: { requestId: string };
    };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.status).toBe(401);
    expect(body.error.hint.length).toBeGreaterThan(0);
    expect(body.meta.requestId).toBe("tunnel-test");
  });

  test("401 with the wrong token", async () => {
    const res = await handleTunnelWrite(
      writeReq({ url: URL }, "Bearer nope"),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("400 on a bad tunnel URL", async () => {
    const res = await handleTunnelWrite(
      writeReq(
        { name: "t3", url: "https://example.com" },
        "Bearer secret-token",
      ),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint: string };
    };
    expect(body.error.code).toBe("invalid_tunnel_url");
    expect(body.error.hint.length).toBeGreaterThan(0);
  });

  test("400 on invalid JSON", async () => {
    const res = await handleTunnelWrite(
      writeReq(null, "Bearer secret-token", "{not json"),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  test("400 missing_name when neither body nor query names the slot", async () => {
    const res = await handleTunnelWrite(
      writeReq({ url: URL }, "Bearer secret-token"),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint: string; status: number };
    };
    expect(body.error.code).toBe("missing_name");
    expect(body.error.status).toBe(400);
    expect(body.error.hint).toContain("t3");
  });

  test("400 invalid_name on an unknown slot", async () => {
    const res = await handleTunnelWrite(
      writeReq({ name: "nope", url: URL }, "Bearer secret-token"),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_name");
  });

  test("200 when the slot comes from ?name= instead of the body", async () => {
    let savedSlot: string | undefined;
    const d = deps({
      store: {
        read: async () => null,
        write: async (slot, rec) => {
          savedSlot = slot;
          return rec;
        },
      },
    });
    const res = await handleTunnelWrite(
      writeReq({ url: URL }, "Bearer secret-token", undefined, "?name=t3"),
      d,
    );
    expect(res.status).toBe(200);
    expect(savedSlot).toBe("t3");
  });

  test("200 stores the record with the success envelope", async () => {
    let saved: TunnelRecord | undefined;
    let savedSlot: string | undefined;
    const d = deps({
      store: {
        read: async () => null,
        write: async (slot, rec) => {
          savedSlot = slot;
          saved = rec;
          return rec;
        },
      },
    });
    const res = await handleTunnelWrite(
      writeReq({ name: "t3", url: URL, runId: "999" }, "Bearer secret-token"),
      d,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("tunnel-test");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = (await res.json()) as {
      data: TunnelRecord;
      page: { next: null };
      meta: { requestId: string };
      warnings: unknown[];
    };
    expect(body.data.url).toBe(URL);
    expect(body.data.runId).toBe("999");
    expect(typeof body.data.updatedAt).toBe("string");
    expect(body.page.next).toBeNull();
    expect(body.meta.requestId).toBe("tunnel-test");
    expect(body.warnings).toEqual([]);
    expect(saved?.url).toBe(URL);
    expect(savedSlot).toBe("t3");
  });

  test("502 when the store write fails", async () => {
    const d = deps({
      store: {
        read: async () => null,
        write: async () => {
          throw new Error("blob down");
        },
      },
    });
    const res = await handleTunnelWrite(
      writeReq({ name: "t3", url: URL }, "Bearer secret-token"),
      d,
    );
    expect(res.status).toBe(502);
  });
});

describe("handleTunnelGet", () => {
  test("400 missing_name on a bare GET with no ?name=", async () => {
    const res = await handleTunnelGet(
      req("http://localhost/api/v1/tunnel-url"),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint: string; status: number };
      meta: { requestId: string };
    };
    expect(body.error.code).toBe("missing_name");
    expect(body.error.status).toBe(400);
    expect(body.error.hint).toContain("?name=t3");
    expect(body.meta.requestId).toBe("tunnel-test");
  });

  test("400 invalid_name on an unknown ?name=", async () => {
    const res = await handleTunnelGet(
      req("http://localhost/api/v1/tunnel-url?name=nope"),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_name");
  });

  test("returns { data: null } when nothing is stored for the slot", async () => {
    const res = await handleTunnelGet(
      req("http://localhost/api/v1/tunnel-url?name=t3"),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("tunnel-test");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = (await res.json()) as {
      data: null;
      page: { next: null };
      meta: { requestId: string };
    };
    expect(body.data).toBeNull();
    expect(body.page.next).toBeNull();
    expect(body.meta.requestId).toBe("tunnel-test");
  });

  test("returns the stored record for the requested slot", async () => {
    const stored: TunnelRecord = {
      url: URL,
      runId: "111",
      updatedAt: "2026-09-14T00:00:00.000Z",
    };
    let readSlot: string | undefined;
    const res = await handleTunnelGet(
      req("http://localhost/api/v1/tunnel-url?name=transcript"),
      deps({
        store: {
          read: async (slot) => {
            readSlot = slot;
            return stored;
          },
          write: async (_slot, r) => r,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: TunnelRecord };
    expect(body.data).toEqual(stored);
    expect(readSlot).toBe("transcript");
  });

  test("502 when the store read fails", async () => {
    const res = await handleTunnelGet(
      req("http://localhost/api/v1/tunnel-url?name=t3"),
      deps({
        store: {
          read: async () => {
            throw new Error("blob down");
          },
          write: async (_slot, r) => r,
        },
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe("parseStoredTunnel", () => {
  test("passes valid records, rejects garbage", () => {
    const rec = { url: URL, runId: "1", updatedAt: "2026-09-14T00:00:00Z" };
    expect(parseStoredTunnel(rec)).toEqual(rec);
    expect(parseStoredTunnel(null)).toBeNull();
    expect(parseStoredTunnel({ url: "https://example.com" })).toBeNull();
    expect(parseStoredTunnel({})).toBeNull();
  });
});
