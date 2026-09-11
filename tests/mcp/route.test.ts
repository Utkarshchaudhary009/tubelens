/// <reference types="bun-types" />
import { beforeEach, describe, expect, test } from "bun:test";
import type { SearchDeps } from "../../src/app/api/v1/search/route";
import type { VideoDeps } from "../../src/app/api/v1/videos/[id]/route";
import { buildMcpHandler } from "../../src/app/mcp/route";
import { clearCache } from "../../src/lib/cache";
import {
  type ContinuationSearch,
  clearContinuations,
} from "../../src/lib/continuations";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

/** Fake youtubei Search over fixed immutable pages. */
function fakeSearch(
  pages: Array<Array<Record<string, unknown>>>,
): ContinuationSearch {
  const page = (idx: number): ContinuationSearch => ({
    results: [...(pages[idx] ?? [])],
    has_continuation: idx < pages.length - 1,
    getContinuation: async () => page(idx + 1),
  });
  return page(0);
}

const node = (id: string, title: string) => ({ type: "Video", id, title });

const searchDeps: SearchDeps = {
  runSearch: async (q) =>
    fakeSearch([
      [node(`${q}-1`, "T1"), node(`${q}-2`, "T2"), node(`${q}-3`, "T3")],
    ]),
  continueSearch: async (s) => s.getContinuation(),
};

const videoDeps: VideoDeps = {
  fetchVideo: async (id) => ({
    id,
    title: "V",
    channel: { id: "c1", name: "C" },
  }),
};

const handler = buildMcpHandler({ search: searchDeps, video: videoDeps });

interface ToolContent {
  type: string;
  text: string;
}

interface RpcOk {
  result: {
    content?: ToolContent[];
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
}
interface RpcErr {
  error: { code: number; message: string };
}

type McpHandler = typeof handler;

async function rpcWith(h: McpHandler, body: unknown): Promise<RpcOk | RpcErr> {
  const res = await h(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  expect(line).toBeDefined();
  return JSON.parse((line ?? "").slice("data: ".length));
}

async function rpc(body: unknown): Promise<RpcOk | RpcErr> {
  return rpcWith(handler, body);
}

function callTool(name: string, args: Record<string, unknown>) {
  return rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function callToolWith(
  h: McpHandler,
  name: string,
  args: Record<string, unknown>,
) {
  return rpcWith(h, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/** Single text content item carrying the REST-style envelope. */
function envelopeOf(result: { content?: ToolContent[]; isError?: boolean }) {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const item = result.content?.[0];
  expect(item?.type).toBe("text");
  const body = JSON.parse(item?.text ?? "");
  expect(body).toHaveProperty("data");
  expect(body).toHaveProperty("page");
  expect(body).toHaveProperty("meta");
  expect(body).toHaveProperty("warnings");
  expect(typeof body.meta.requestId).toBe("string");
  return body;
}

function errorBodyOf(result: { content?: ToolContent[]; isError?: boolean }) {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content?.[0]?.text ?? "");
}

describe("mcp tools/list", () => {
  test("exposes exactly the 2 read-only tools", async () => {
    const msg = (await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as RpcOk;
    const names = (msg.result.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["get_video", "search"]);
  });
});

describe("mcp search tool (mocked upstream)", () => {
  test("returns the REST envelope shape as single text content", async () => {
    const msg = (await callTool("search", { q: "lofi" })) as RpcOk;
    const body = envelopeOf(msg.result);
    expect(body.data.map((d: { id: string }) => d.id)).toEqual([
      "lofi-1",
      "lofi-2",
      "lofi-3",
    ]);
    expect(body.meta.region).toBe("US");
    expect(body.meta.lang).toBe("en");
  });

  test("missing q returns structured missing_query, never a throw", async () => {
    const msg = (await callTool("search", {})) as RpcOk;
    expect(msg.result.isError).toBe(true);
    const body = errorBodyOf(msg.result);
    expect(body.error.code).toBe("missing_query");
    expect(body.error.status).toBe(400);
    expect(typeof body.error.hint).toBe("string");
  });

  test("limit above 50 clamps to 50 instead of erroring", async () => {
    const many: SearchDeps = {
      runSearch: async (q) =>
        fakeSearch([
          Array.from({ length: 60 }, (_, i) =>
            node(`${q}-${i + 1}`, `T${i + 1}`),
          ),
        ]),
      continueSearch: async (s) => s.getContinuation(),
    };
    const wide = buildMcpHandler({ search: many, video: videoDeps });
    const hi = (await callToolWith(wide, "search", {
      q: "clamp-hi",
      limit: 200,
    })) as RpcOk;
    // 200 clamps to 50: exactly 50 of the 60 mocked items served.
    expect(envelopeOf(hi.result).data).toHaveLength(50);
  });

  test("limit below 1 clamps to 1 instead of erroring", async () => {
    const lo = (await callTool("search", {
      q: "clamp-lo",
      limit: 0,
    })) as RpcOk;
    // 0 clamps to 1: exactly one item served.
    expect(envelopeOf(lo.result).data).toHaveLength(1);
  });

  test("non-integer limit fails at the schema boundary", async () => {
    const msg = (await callTool("search", {
      q: "float",
      limit: 2.5,
    })) as RpcOk;
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content?.[0]?.text).toContain("limit");
  });

  test("invalid type is rejected at the schema boundary", async () => {
    const msg = (await callTool("search", { q: "x", type: "bogus" })) as RpcOk;
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content?.[0]?.text).toContain("type");
  });
});

describe("mcp search cursors and upstream errors (mocked upstream)", () => {
  test("cursor round-trips page 1 -> page 2", async () => {
    const first = (await callTool("search", {
      q: "walk",
      limit: 2,
    })) as RpcOk;
    const b1 = envelopeOf(first.result);
    expect(b1.data.map((d: { id: string }) => d.id)).toEqual([
      "walk-1",
      "walk-2",
    ]);
    expect(typeof b1.page.next).toBe("string");

    const second = (await callTool("search", {
      cursor: b1.page.next,
      limit: 2,
    })) as RpcOk;
    const b2 = envelopeOf(second.result);
    expect(b2.data.map((d: { id: string }) => d.id)).toEqual(["walk-3"]);
  });

  test("unknown cursor yields an empty page, never an error", async () => {
    const msg = (await callTool("search", {
      cursor: "expired-or-bogus",
    })) as RpcOk;
    const body = envelopeOf(msg.result);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ next: null });
  });

  test("runSearch rejection surfaces the upstream code as error content", async () => {
    const failing = buildMcpHandler({
      search: {
        runSearch: async () => {
          throw new Error("boom");
        },
        continueSearch: async (s) => s.getContinuation(),
      },
      video: videoDeps,
    });
    const msg = (await callToolWith(failing, "search", {
      q: "downstream-down",
    })) as RpcOk;
    expect(msg.result.isError).toBe(true);
    const body = errorBodyOf(msg.result);
    expect(body.error.code).toBe("upstream_degraded");
  });

  test("invalid region/lang fall back to US/en like REST", async () => {
    const msg = (await callTool("search", {
      q: "locale",
      region: "USA!",
      lang: "ENGLISH",
    })) as RpcOk;
    const body = envelopeOf(msg.result);
    expect(body.meta.region).toBe("US");
    expect(body.meta.lang).toBe("en");
  });
});

describe("mcp get_video tool (mocked upstream)", () => {
  test("returns the REST envelope shape as single text content", async () => {
    const msg = (await callTool("get_video", {
      id: "dQw4w9WgXcQ",
    })) as RpcOk;
    const body = envelopeOf(msg.result);
    expect(body.data).toMatchObject({ id: "dQw4w9WgXcQ", title: "V" });
  });

  test("bad id returns structured invalid_video_id, never a throw", async () => {
    const msg = (await callTool("get_video", { id: "!!!" })) as RpcOk;
    expect(msg.result.isError).toBe(true);
    const body = errorBodyOf(msg.result);
    expect(body.error.code).toBe("invalid_video_id");
    expect(body.error.status).toBe(400);
    expect(typeof body.error.hint).toBe("string");
  });

  test("missing id returns structured invalid_video_id", async () => {
    const msg = (await callTool("get_video", {})) as RpcOk;
    expect(msg.result.isError).toBe(true);
    const body = errorBodyOf(msg.result);
    expect(body.error.code).toBe("invalid_video_id");
  });
});
