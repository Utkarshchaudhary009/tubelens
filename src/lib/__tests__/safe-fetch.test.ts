// Part B Phase 10 — SSRF boundary tests: the shared safeFetch client plus
// per-caller regression coverage proving SsrfBlockedError maps to typed
// hints (never bare 500s, never a fetch to the blocked target).
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { classifyAudioError } from "../audio";
import { handleSponsors } from "../community";
import {
  isAllowedHost,
  isBlockedAddress,
  isLoopbackHost,
  parseIPv4Literal,
  type SafeFetchFn,
  SsrfBlockedError,
  safeFetch,
} from "../safe-fetch";
import {
  type FetchLike,
  runTranscriptWaterfall,
  TRANSCRIPT_PROVIDERS,
} from "../transcript-providers";
import { handleBatch } from "../utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Transport stub recording every fetched URL in order. */
function mockFetch(
  handler: (url: string) => Response,
): SafeFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: SafeFetchFn = async (input: string) => {
    calls.push(input);
    return handler(input);
  };
  return Object.assign(fn, { calls });
}

const mustNotFetch: SafeFetchFn = async () => {
  throw new Error("fetch must not run for a blocked destination");
};

const mustNotResolve = async (_host: string): Promise<string[]> => {
  throw new Error("DNS must not run past the static boundary");
};

/** Public-IP DNS stub (proves the DNS stage passes for legit hosts). */
const publicDns = async () => ["93.184.216.34"];

const ok = (text = "ok"): Response => new Response(text, { status: 200 });

const redirectTo = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { Location: location } });

async function ssrfOf(p: Promise<unknown>): Promise<SsrfBlockedError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SsrfBlockedError);
    return err as SsrfBlockedError;
  }
  throw new Error("expected SsrfBlockedError, request succeeded");
}

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": "ssrf" } });
}

// ---------------------------------------------------------------------------
// Static boundary: loopback / private / link-local / metadata
// ---------------------------------------------------------------------------

describe("safe-fetch static boundary", () => {
  test("loopback destinations blocked without fetching", async () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://127.0.0.1./",
      "http://localhost/",
      "https://localhost/",
      "https://localhost.localdomain/",
      "https://app.localhost/",
      "https://[::1]/",
      "http://[::1]/",
      "https://0.0.0.0/",
      "https://[::]/",
      "https://[::ffff:127.0.0.1]/",
    ]) {
      const err = await ssrfOf(
        safeFetch(url, {
          allowHosts: ["example.com"],
          fetchFn: mustNotFetch,
          resolveFn: mustNotResolve,
        }),
      );
      expect(err.code).toBe("ssrf_blocked");
    }
  });

  test("RFC1918 private ranges blocked without fetching", async () => {
    for (const url of [
      "https://10.0.0.1/",
      "https://10.255.255.255/",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.0.1/",
      "https://192.168.255.255/",
      "https://100.64.0.1/",
      "https://[fc00::1]/",
      "https://[fe80::1]/",
      "https://[ff02::1]/",
    ]) {
      await ssrfOf(
        safeFetch(url, {
          allowHosts: ["example.com"],
          fetchFn: mustNotFetch,
          resolveFn: mustNotResolve,
        }),
      );
    }
    // 172.15/172.32 are public — only the range shape is asserted here via
    // the classifier (no fetch either way without an allowlist match).
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
  });

  test("link-local + cloud metadata endpoints blocked", async () => {
    for (const url of [
      "https://169.254.169.254/",
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/",
      "https://metadata.google/",
      "https://instance-data/",
      "https://100.100.100.200/",
    ]) {
      await ssrfOf(
        safeFetch(url, {
          allowHosts: ["example.com"],
          fetchFn: mustNotFetch,
          resolveFn: mustNotResolve,
        }),
      );
    }
  });

  test("decimal/octal/hex IP encodings decode to blocked loopback/private", () => {
    expect(parseIPv4Literal("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Literal("0x7f.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Literal("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Literal("0x7f.000.000.001")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Literal("0xC0.168.1.1")).toEqual([192, 168, 1, 1]);
    expect(parseIPv4Literal("3232235777")).toEqual([192, 168, 1, 1]);
    for (const host of [
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "0x7f.000.000.001",
      "0xC0.168.1.1",
      "3232235777",
      "285203 whitenoise",
    ]) {
      expect(isBlockedAddress(host)).toBe(true);
    }
  });

  test("trick-encoded URLs blocked at safeFetch without fetching", async () => {
    for (const url of [
      "https://2130706433/",
      "https://0x7f.0.0.1/",
      "https://0177.0.0.1/",
      "https://0xC0.168.1.1/",
    ]) {
      await ssrfOf(
        safeFetch(url, {
          allowHosts: ["example.com"],
          fetchFn: mustNotFetch,
          resolveFn: mustNotResolve,
        }),
      );
    }
  });

  test("off-allowlist host blocked before DNS/fetch", async () => {
    await ssrfOf(
      safeFetch("https://evil.example/", {
        allowHosts: ["yttools.co"],
        fetchFn: mustNotFetch,
        resolveFn: mustNotResolve,
      }),
    );
  });

  test("rejection carries no credentials", async () => {
    const err = await ssrfOf(
      safeFetch("https://user:s3cret@evil.example/", {
        allowHosts: ["yttools.co"],
        fetchFn: mustNotFetch,
      }),
    );
    expect(String(err)).not.toContain("s3cret");
    expect(String(err)).not.toContain("user");
  });
});

// ---------------------------------------------------------------------------
// Redirect boundary
// ---------------------------------------------------------------------------

describe("safe-fetch redirect boundary", () => {
  test("http downgrade on redirect blocked, target never fetched", async () => {
    const fetchFn = mockFetch(() => redirectTo("http://yttools.co/other"));
    await ssrfOf(
      safeFetch("https://yttools.co/start", {
        allowHosts: ["yttools.co"],
        fetchFn,
        resolveFn: publicDns,
      }),
    );
    expect(fetchFn.calls).toEqual(["https://yttools.co/start"]);
  });

  test("cross-origin redirect escape blocked, target never fetched", async () => {
    const fetchFn = mockFetch(() => redirectTo("https://evil.example/collect"));
    await ssrfOf(
      safeFetch("https://yttools.co/start", {
        allowHosts: ["yttools.co"],
        fetchFn,
        resolveFn: publicDns,
      }),
    );
    expect(fetchFn.calls).toEqual(["https://yttools.co/start"]);
  });

  test("redirect to IP-literal trick blocked, target never fetched", async () => {
    const fetchFn = mockFetch(() => redirectTo("https://2130706433/x"));
    await ssrfOf(
      safeFetch("https://yttools.co/start", {
        allowHosts: ["yttools.co"],
        fetchFn,
        resolveFn: publicDns,
      }),
    );
    expect(fetchFn.calls).toEqual(["https://yttools.co/start"]);
  });

  test("allowed same-host redirect passes", async () => {
    const fetchFn = mockFetch((url: string) =>
      url.endsWith("/start") ? redirectTo("/next") : ok("done"),
    );
    const res = await safeFetch("https://yttools.co/start", {
      allowHosts: ["yttools.co"],
      fetchFn,
      resolveFn: publicDns,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("done");
    expect(fetchFn.calls).toEqual([
      "https://yttools.co/start",
      "https://yttools.co/next",
    ]);
  });

  test("maxRedirects exceeded throws without further fetching", async () => {
    const fetchFn = mockFetch(() => redirectTo("/loop"));
    await ssrfOf(
      safeFetch("https://yttools.co/start", {
        allowHosts: ["yttools.co"],
        maxRedirects: 1,
        fetchFn,
        resolveFn: publicDns,
      }),
    );
    expect(fetchFn.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// DNS pinning + allowlist matching + loopback opt-in
// ---------------------------------------------------------------------------

describe("safe-fetch dns pinning and matching", () => {
  test("DNS resolving to private IP blocked, never fetched", async () => {
    await ssrfOf(
      safeFetch("https://yttools.co/api/t", {
        allowHosts: ["yttools.co"],
        fetchFn: mustNotFetch,
        resolveFn: async () => ["10.1.2.3"],
      }),
    );
  });

  test("DNS lookup failure fails closed, never fetched", async () => {
    await ssrfOf(
      safeFetch("https://yttools.co/api/t", {
        allowHosts: ["yttools.co"],
        fetchFn: mustNotFetch,
        resolveFn: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
            code: "ENOTFOUND",
          });
        },
      }),
    );
  });

  test("isAllowedHost: exact, suffix, regex, case-insensitive", () => {
    expect(isAllowedHost("sponsor.ajay.app", ["sponsor.ajay.app"])).toBe(true);
    expect(isAllowedHost("Sponsor.Ajay.App", ["sponsor.ajay.app"])).toBe(true);
    expect(isAllowedHost("evil.com", ["sponsor.ajay.app"])).toBe(false);
    expect(
      isAllowedHost("r1---sn.googlevideo.com", [/\.googlevideo\.com$/]),
    ).toBe(true);
    expect(isAllowedHost("notgooglevideo.com", [/\.googlevideo\.com$/])).toBe(
      false,
    );
    expect(isAllowedHost("sub.example.com", [".example.com"])).toBe(true);
    expect(isAllowedHost("example.com", [".example.com"])).toBe(true);
    expect(isAllowedHost("notexample.com", [".example.com"])).toBe(false);
  });

  test("isLoopbackHost distinguishes loopback from private", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  test("allowLoopback opts in http loopback only", async () => {
    const fetchFn = mockFetch(() => ok("local"));
    const res = await safeFetch("http://127.0.0.1:3000/api/v1/health", {
      allowHosts: ["127.0.0.1"],
      allowLoopback: true,
      fetchFn,
    });
    expect(res.status).toBe(200);
    // Same URL without the opt-in: protocol gate rejects before fetching.
    await ssrfOf(
      safeFetch("http://127.0.0.1:3000/api/v1/health", {
        allowHosts: ["127.0.0.1"],
        fetchFn: mustNotFetch,
      }),
    );
    // Opt-in never extends to private ranges.
    await ssrfOf(
      safeFetch("https://10.0.0.1/", {
        allowHosts: ["10.0.0.1"],
        allowLoopback: true,
        fetchFn: mustNotFetch,
        resolveFn: mustNotResolve,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Per-caller regressions: SsrfBlockedError -> typed hints, never bare 500
// ---------------------------------------------------------------------------

describe("safe-fetch caller regressions", () => {
  test("community sponsors maps SsrfBlockedError to typed 502 hint", async () => {
    const res = await handleSponsors(
      req("http://x/api/v1/videos/SsrfTest01/sponsors"),
      "SsrfTest01",
      {
        fetchSponsors: async () => {
          throw new SsrfBlockedError("blocked destination");
        },
      },
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("X-Request-Id")).toBe("ssrf");
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  test("batch maps SsrfBlockedError to per-item 502, batch stays 200", async () => {
    const saved = process.env.TUBELENS_PUBLIC_URL;
    process.env.TUBELENS_PUBLIC_URL = "https://api.example.com";
    try {
      const res = await handleBatch(
        new NextRequest("http://x/api/v1/batch", {
          method: "POST",
          body: JSON.stringify({
            requests: [{ method: "GET", path: "/api/v1/health" }],
          }),
          headers: {
            "content-type": "application/json",
            "x-request-id": "ssrf",
          },
        }),
        {
          execute: async () => {
            throw new SsrfBlockedError("blocked destination");
          },
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const [item] = body.data.results as Array<{
        status: number;
        body: unknown;
      }>;
      expect(item.status).toBe(502);
      expect((item.body as { error: { code: string } }).error.code).toBe(
        "batch_upstream_failed",
      );
      expect(typeof (item.body as { error: { hint: string } }).error.hint).toBe(
        "string",
      );
    } finally {
      if (saved === undefined) {
        delete process.env.TUBELENS_PUBLIC_URL;
      } else {
        process.env.TUBELENS_PUBLIC_URL = saved;
      }
    }
  });

  test("audio maps SsrfBlockedError to 502, never definitive 410", () => {
    const classified = classifyAudioError(
      new SsrfBlockedError("blocked destination"),
    );
    expect(classified.code).toBe("upstream_degraded");
    expect(classified.status).toBe(502);
    expect(typeof classified.hint).toBe("string");
  });

  test("transcript waterfall fails over past an SSRF-blocked provider", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.includes("yttools.co")) {
        return {
          ok: false,
          status: 302,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "location"
                ? "https://evil.example/collect"
                : null,
          },
          json: async () => ({}),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (_name: string) => null },
        json: async () => ({
          transcript: [{ text: "hi", offset: 0, duration: 1000, lang: "en" }],
        }),
        text: async () => "",
      };
    }) as unknown as FetchLike;
    const yttools = TRANSCRIPT_PROVIDERS[1];
    const fallback = TRANSCRIPT_PROVIDERS[3];
    if (!yttools || !fallback) {
      throw new Error("registry fixture missing");
    }
    const result = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: async () => {
        throw new Error("no native");
      },
      fetchFn,
      providers: [yttools, fallback],
    });
    expect(result.provider).toBe(fallback.name);
    expect(result.segments).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((u) => !u.includes("evil.example"))).toBe(true);
  });
});
