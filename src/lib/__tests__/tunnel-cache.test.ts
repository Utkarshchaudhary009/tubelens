import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleTranscript } from "../../app/api/v1/videos/[id]/transcript/route";
import { clearCache } from "../cache";
import type { FetchLike } from "../transcript-providers";
import {
  clearTunnelCache,
  getCachedTunnelUrl,
  isTunnelUrl,
  resolveTunnelUrl,
  setCachedTunnelUrl,
  TUNNEL_CACHE_TTL_MS,
  TUNNEL_RESOLVE_BUDGET_MS,
} from "../tunnel-cache";
import { handleTunnelWrite, type TunnelDeps } from "../tunnel-url";

const TTS_URL = "https://abc-123.trycloudflare.com";
const TTS_FIXTURE = {
  videoId: "dQw4w9WgXcQ",
  transcript: [
    { text: "Hello world", start: 1.5, duration: 2.5, lang: "en" },
    { text: "Second line", start: 4.0, duration: 1.0, lang: "en" },
  ],
};

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  clearCache();
  clearTunnelCache();
  savedEnv = {
    TTS_TRANSCRIPT_URL: process.env.TTS_TRANSCRIPT_URL,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  };
  delete process.env.TTS_TRANSCRIPT_URL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(() => {
  clearTunnelCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

function req(url: string, requestId = "tunnel-cache"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

function stubRes(ok: boolean, status: number, jsonBody: unknown) {
  return {
    ok,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  };
}

describe("isTunnelUrl", () => {
  test("pins to https *.trycloudflare.com, rejects everything else", () => {
    expect(isTunnelUrl(TTS_URL)).toBe(true);
    expect(
      isTunnelUrl("https://abc-123.trycloudflare.com/pair#token=ABC"),
    ).toBe(true);
    for (const bad of [
      "http://abc-123.trycloudflare.com",
      "https://example.com",
      "https://example.com.evil",
      "https://trycloudflare.com.evil.com",
      "",
      "  ",
      "not a url",
      null,
      undefined,
      42,
    ]) {
      expect(isTunnelUrl(bad)).toBe(false);
    }
  });
});

describe("memory cache", () => {
  test("miss -> undefined; set -> sync hit; TTL expiry -> miss", () => {
    expect(getCachedTunnelUrl("transcript")).toBeUndefined();
    setCachedTunnelUrl("transcript", TTS_URL, 1000);
    expect(getCachedTunnelUrl("transcript", 1000)).toBe(TTS_URL);
    expect(getCachedTunnelUrl("transcript", 1000 + TUNNEL_CACHE_TTL_MS)).toBe(
      TTS_URL,
    );
    expect(
      getCachedTunnelUrl("transcript", 1000 + TUNNEL_CACHE_TTL_MS + 1),
    ).toBeUndefined();
  });

  test("slots are independent; blank/non-tunnel sets ignored", () => {
    setCachedTunnelUrl("transcript", TTS_URL);
    expect(getCachedTunnelUrl("t3")).toBeUndefined();
    setCachedTunnelUrl("t3", "   ");
    setCachedTunnelUrl("t3", "https://example.com.evil");
    expect(getCachedTunnelUrl("t3")).toBeUndefined();
  });

  test("clearTunnelCache drops one slot or all", () => {
    setCachedTunnelUrl("transcript", TTS_URL);
    setCachedTunnelUrl("t3", "https://x-1.trycloudflare.com");
    clearTunnelCache("transcript");
    expect(getCachedTunnelUrl("transcript")).toBeUndefined();
    expect(getCachedTunnelUrl("t3")).toBe("https://x-1.trycloudflare.com");
    clearTunnelCache();
    expect(getCachedTunnelUrl("t3")).toBeUndefined();
  });
});

describe("resolveTunnelUrl", () => {
  test("memory hit wins without touching Blob", async () => {
    setCachedTunnelUrl("transcript", TTS_URL);
    let reads = 0;
    const out = await resolveTunnelUrl("transcript", {
      envUrl: "https://other.trycloudflare.com",
      read: async () => {
        reads += 1;
        return {
          url: "https://blob.trycloudflare.com",
          runId: "",
          updatedAt: "",
        };
      },
    });
    expect(out).toBe(TTS_URL);
    expect(reads).toBe(0);
  });

  test("env hit caches with zero Blob reads", async () => {
    let reads = 0;
    const out = await resolveTunnelUrl("transcript", {
      envUrl: TTS_URL,
      read: async () => {
        reads += 1;
        return null;
      },
    });
    expect(out).toBe(TTS_URL);
    expect(reads).toBe(0);
    expect(getCachedTunnelUrl("transcript")).toBe(TTS_URL);
  });

  test("Blob miss path reads once and caches; concurrent misses join", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { url: TTS_URL, runId: "1", updatedAt: "x" };
    };
    const [a, b] = await Promise.all([
      resolveTunnelUrl("transcript", { read }),
      resolveTunnelUrl("transcript", { read }),
    ]);
    expect(a).toBe(TTS_URL);
    expect(b).toBe(TTS_URL);
    expect(reads).toBe(1);
    expect(getCachedTunnelUrl("transcript")).toBe(TTS_URL);
  });

  test("Blob failure never throws: stale/env fallback, else undefined", async () => {
    const failing = async (): Promise<{ url: string } | null> => {
      throw new Error("blob down");
    };
    // No stale, no env -> undefined (provider skips silently, never a 500).
    expect(
      await resolveTunnelUrl("transcript", { read: failing }),
    ).toBeUndefined();
    // Stale entry survives a Blob outage.
    setCachedTunnelUrl("transcript", TTS_URL, 0);
    const stale = await resolveTunnelUrl("transcript", {
      read: failing,
      now: () => TUNNEL_CACHE_TTL_MS + 10_000,
    });
    expect(stale).toBe(TTS_URL);
    // Blob non-tunnel URLs never resolve (pinned layer), never throws.
    clearTunnelCache();
    for (const url of [
      "https://example.com.evil",
      "https://example.com",
      "http://abc.trycloudflare.com",
    ]) {
      const out = await resolveTunnelUrl("transcript", {
        read: async () => ({ url, runId: "", updatedAt: "" }),
      });
      expect(out).toBeUndefined();
    }
    expect(getCachedTunnelUrl("transcript")).toBeUndefined();
  });

  test("hung Blob read is budget-bounded, falls back fast", async () => {
    const hanging = (): Promise<{ url: string } | null> =>
      new Promise(() => {});
    const started = Date.now();
    const out = await resolveTunnelUrl("transcript", {
      read: hanging,
      timeoutMs: 25,
    });
    expect(out).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    // ... and a stale tunnel URL still serves through the hang.
    setCachedTunnelUrl("transcript", TTS_URL, 0);
    const stale = await resolveTunnelUrl("transcript", {
      read: hanging,
      timeoutMs: 25,
      now: () => TUNNEL_CACHE_TTL_MS + 10_000,
    });
    expect(stale).toBe(TTS_URL);
    expect(TUNNEL_RESOLVE_BUDGET_MS).toBeLessThanOrEqual(1000);
  });

  test("refresh race: slow Blob settle never clobbers a newer POST", async () => {
    const FRESH_URL = "https://fresh-999.trycloudflare.com";
    let release: ((v: { url: string }) => void) | undefined;
    const slowRead = () =>
      new Promise<{ url: string }>((resolve) => {
        release = resolve;
      });
    const pending = resolveTunnelUrl("transcript", {
      read: slowRead,
      now: () => 1000,
    });
    // POST lands mid-read with a newer stamp (refresh-on-save path).
    setCachedTunnelUrl("transcript", FRESH_URL, 2000);
    release?.({ url: TTS_URL });
    await expect(pending).resolves.toBe(FRESH_URL);
    expect(getCachedTunnelUrl("transcript", 2000)).toBe(FRESH_URL);
  });
});

describe("refresh-on-save", () => {
  function writeDeps(): TunnelDeps & { saved: { url?: string } } {
    const saved: { url?: string } = {};
    return {
      saved,
      store: {
        read: async () => null,
        write: async (_slot, rec) => {
          saved.url = rec.url;
          return rec;
        },
      },
      expectedToken: "secret-token",
    };
  }

  test("successful POST publishes the fresh URL to memory", async () => {
    const d = writeDeps();
    const res = await handleTunnelWrite(
      new NextRequest("http://localhost/api/v1/tunnel-url", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
          "x-request-id": "tunnel-cache",
        },
        body: JSON.stringify({ name: "transcript", url: TTS_URL }),
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(getCachedTunnelUrl("transcript")).toBe(TTS_URL);
  });

  test("failed write leaves the cache alone", async () => {
    setCachedTunnelUrl("transcript", TTS_URL);
    const d = writeDeps();
    d.store.write = async () => {
      throw new Error("blob down");
    };
    const res = await handleTunnelWrite(
      new NextRequest("http://localhost/api/v1/tunnel-url", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
          "x-request-id": "tunnel-cache",
        },
        body: JSON.stringify({
          name: "transcript",
          url: "https://fresh-999.trycloudflare.com",
        }),
      }),
      d,
    );
    expect(res.status).toBe(502);
    expect(getCachedTunnelUrl("transcript")).toBe(TTS_URL);
  });
});

describe("transcript route injection", () => {
  const nativeThrow = (msg: string) => async () => {
    throw new Error(msg);
  };
  const ttsFetch = (): FetchLike => async (url) => {
    if (url.startsWith(TTS_URL)) {
      return stubRes(true, 200, TTS_FIXTURE);
    }
    return stubRes(false, 422, {});
  };

  test("cached base enables head-of-chain tts-test with no env (zero Blob)", async () => {
    setCachedTunnelUrl("transcript", TTS_URL);
    const id = "Tc000000001";
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript?lang=fr`),
      id,
      {
        fetchNative: nativeThrow("no native"),
        fetchFn: ttsFetch(),
        env: {},
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.lang).toBe("fr");
    expect(body.data).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "Hello world" },
      { startSeconds: 4, durationSeconds: 1, text: "Second line" },
    ]);
    expect(body.warnings).toMatchObject([
      { code: "fallback_source", message: expect.stringContaining("tts-test") },
    ]);
  });

  test("head entry wins over a healthy fast path; tail still serves on head failure", async () => {
    // Head wins: native would serve, but cached tts-test runs first.
    setCachedTunnelUrl("transcript", TTS_URL);
    const headId = "Tc000000002";
    const head = await handleTranscript(
      req(`http://x/api/v1/videos/${headId}/transcript`),
      headId,
      {
        fetchNative: async () => [{ startSeconds: 0, text: "fast" }],
        fetchFn: ttsFetch(),
        env: {},
      },
    );
    expect(head.status).toBe(200);
    expect((await head.json()).warnings).toMatchObject([
      { code: "fallback_source", message: expect.stringContaining("tts-test") },
    ]);

    // Tail reachable: tts-test fails over to yttools within budget.
    clearTunnelCache();
    const tailId = "Tc000000003";
    const yttoolsFetch: FetchLike = async (url) => {
      if (url.startsWith(TTS_URL)) {
        return stubRes(false, 422, {});
      }
      if (url.includes("yttools.co")) {
        return stubRes(true, 200, {
          transcript: [{ text: "hi", offset: 1000, duration: 500, lang: "en" }],
        });
      }
      return stubRes(false, 422, {});
    };
    const tail = await handleTranscript(
      req(`http://x/api/v1/videos/${tailId}/transcript`),
      tailId,
      {
        fetchNative: nativeThrow("no native"),
        fetchFn: yttoolsFetch,
        env: { TTS_TRANSCRIPT_URL: TTS_URL },
      },
    );
    expect(tail.status).toBe(200);
    expect((await tail.json()).warnings).toMatchObject([
      { code: "fallback_source", message: expect.stringContaining("yttools") },
    ]);
  });
});
