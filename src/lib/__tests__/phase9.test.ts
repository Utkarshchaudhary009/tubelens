import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { buildOpenApiDocument } from "../../app/api/v1/openapi.json/route";
import {
  AUDIO_URL_TTL_MS,
  type AudioDeps,
  type AudioFormatInfo,
  assembleRadioQueue,
  type ByteRange,
  classifyAudioError,
  clearAudioBlockedForTests,
  handleAudio,
  handleLyrics,
  handleRadio,
  isAudioBlocked,
  type LyricsDeps,
  mapLyricsShelf,
  mapRadioTrack,
  markAudioBlocked,
  mintSignedAudioUrl,
  parseRangeHeader,
  type RadioDeps,
  type RadioTrackDTO,
  signAudioToken,
  verifyAudioToken,
} from "../audio";
import { clearCache } from "../cache";
import {
  type ContinuationSearch,
  clearContinuations,
  dropContinuation,
} from "../continuations";

const VID = "dQw4w9WgXcQ";
const OTHER = "9bZkp7q19f0";

function req(
  url: string,
  init?: { headers?: Record<string, string> },
): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", "phase9");
  return new NextRequest(url, { headers });
}

function enableAudio(): void {
  process.env.TUBELENS_AUDIO_ENABLED = "1";
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.enabled = process.env.TUBELENS_AUDIO_ENABLED;
  savedEnv.secret = process.env.TUBELENS_AUDIO_SECRET;
  savedEnv.blocked = process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  delete process.env.TUBELENS_AUDIO_ENABLED;
  delete process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  // Every test gets a signing secret unless it explicitly deletes it (the
  // no-secret case must fail closed — see the audio_not_configured test).
  process.env.TUBELENS_AUDIO_SECRET = "phase9-test-secret";
  clearCache();
  clearContinuations();
  clearAudioBlockedForTests();
});

afterEach(() => {
  if (savedEnv.enabled === undefined) {
    delete process.env.TUBELENS_AUDIO_ENABLED;
  } else {
    process.env.TUBELENS_AUDIO_ENABLED = savedEnv.enabled;
  }
  if (savedEnv.secret === undefined) {
    delete process.env.TUBELENS_AUDIO_SECRET;
  } else {
    process.env.TUBELENS_AUDIO_SECRET = savedEnv.secret;
  }
  if (savedEnv.blocked === undefined) {
    delete process.env.TUBELENS_AUDIO_BLOCKED_IDS;
  } else {
    process.env.TUBELENS_AUDIO_BLOCKED_IDS = savedEnv.blocked;
  }
  clearCache();
  clearContinuations();
  clearAudioBlockedForTests();
});

// ---------------------------------------------------------------------------
// Flag gate: OFF -> 403 audio_disabled on all three routes
// ---------------------------------------------------------------------------

describe("phase 9 flag gate (default OFF)", () => {
  const audioDeps: AudioDeps = {
    fetchFormat: async () => ({ mimeType: "audio/webm" }),
    fetchRange: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "audio/webm",
      totalLength: 3,
    }),
  };
  const radioDeps: RadioDeps = {
    fetchAutomix: async () => ({
      results: [{ type: "PlaylistPanelVideo", video_id: "v1", title: "T1" }],
      has_continuation: false,
      getContinuation: async () => {
        throw new Error("exhausted");
      },
    }),
    continueAutomix: async () => {
      throw new Error("exhausted");
    },
    fetchRelated: async () => ({
      results: [],
      has_continuation: false,
      getContinuation: async () => {
        throw new Error("exhausted");
      },
    }),
    continueRelated: async () => {
      throw new Error("exhausted");
    },
  };
  const lyricsDeps: LyricsDeps = {
    fetchLyrics: async () => ({ lines: null, text: "la la" }),
  };

  test("audio JSON mode -> 403 audio_disabled", async () => {
    const res = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      audioDeps,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("audio_disabled");
    expect(body.error.hint).toContain("TUBELENS_AUDIO_ENABLED");
  });

  test("audio bytes mode -> 403 audio_disabled even with a token", async () => {
    enableAudio();
    const { url } = mintSignedAudioUrl("http://x", VID);
    const params = new URL(url).searchParams;
    delete process.env.TUBELENS_AUDIO_ENABLED;
    const res = await handleAudio(
      req(
        `http://x/api/v1/videos/${VID}/audio?token=${params.get("token")}&exp=${params.get("exp")}`,
      ),
      VID,
      audioDeps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("audio_disabled");
  });

  test("radio -> 403 audio_disabled", async () => {
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio`),
      VID,
      radioDeps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("audio_disabled");
  });

  test("lyrics -> 403 audio_disabled", async () => {
    const res = await handleLyrics(
      req(`http://x/api/v1/videos/${VID}/lyrics`),
      VID,
      lyricsDeps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("audio_disabled");
  });

  test("flag ON but no secret -> 503 audio_not_configured (both modes)", async () => {
    enableAudio();
    delete process.env.TUBELENS_AUDIO_SECRET;
    const deps: AudioDeps = {
      fetchFormat: async () => ({ mimeType: "audio/webm" }),
      fetchRange: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "audio/webm",
        totalLength: 3,
      }),
    };
    const resJson = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(resJson.status).toBe(503);
    const bodyJson = await resJson.json();
    expect(bodyJson.error.code).toBe("audio_not_configured");
    expect(typeof bodyJson.error.hint).toBe("string");

    // A token minted under a previous secret must not validate either —
    // the configured gate fires before any token check.
    process.env.TUBELENS_AUDIO_SECRET = "earlier-secret";
    const { url } = mintSignedAudioUrl("http://x", VID);
    delete process.env.TUBELENS_AUDIO_SECRET;
    const resBytes = await handleAudio(req(url), VID, deps);
    expect(resBytes.status).toBe(503);
    expect((await resBytes.json()).error.code).toBe("audio_not_configured");
  });
});

// ---------------------------------------------------------------------------
// Audio signing
// ---------------------------------------------------------------------------

describe("phase 9 audio signing", () => {
  test("minted token verifies; expiry matches the 10-minute TTL", () => {
    const now = Date.now();
    const { url, expiresAt } = mintSignedAudioUrl("http://x", VID, now);
    const params = new URL(url).searchParams;
    const exp = params.get("exp") ?? "";
    expect(params.get("token") ?? "").toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAudioToken(VID, exp, params.get("token"), now)).toBe(true);
    expect(new Date(expiresAt).getTime() - now).toBeLessThanOrEqual(
      AUDIO_URL_TTL_MS,
    );
    expect(signAudioToken(VID, exp)).toBe(params.get("token") ?? "");
  });

  test("expired token rejected", () => {
    const past = Date.now() - 60 * 60 * 1000;
    const { url } = mintSignedAudioUrl("http://x", VID, past);
    const params = new URL(url).searchParams;
    expect(verifyAudioToken(VID, params.get("exp"), params.get("token"))).toBe(
      false,
    );
  });

  test("tampered token and wrong id rejected", () => {
    const { url } = mintSignedAudioUrl("http://x", VID);
    const params = new URL(url).searchParams;
    const token = params.get("token") ?? "";
    const bad = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(verifyAudioToken(VID, params.get("exp"), bad)).toBe(false);
    expect(verifyAudioToken(OTHER, params.get("exp"), token)).toBe(false);
    expect(verifyAudioToken(VID, params.get("exp"), null)).toBe(false);
    expect(verifyAudioToken(VID, "not-a-number", token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audio route: signed-URL mode + bytes mode
// ---------------------------------------------------------------------------

function rangeAwareAudioDeps(total = 1000): AudioDeps & { calls: ByteRange[] } {
  const calls: ByteRange[] = [];
  const full = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    full[i] = i % 256;
  }
  return {
    calls,
    fetchFormat: async (): Promise<AudioFormatInfo> => ({
      mimeType: "audio/webm",
      bitrate: 128000,
      contentLength: total,
    }),
    fetchRange: async (_id: string, range: ByteRange | null) => {
      if (range) {
        calls.push(range);
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? total - 1;
      return {
        bytes: full.slice(start, Math.min(end, total - 1) + 1),
        contentType: "audio/webm",
        totalLength: total,
      };
    },
  };
}

describe("phase 9 audio route", () => {
  test("JSON mode returns a verifiable same-origin signed URL, never raw upstream", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const res = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toMatch(/^http:\/\/x\/api\/v1\/videos\/.+\/audio\?/);
    expect(typeof body.data.expiresAt).toBe("string");
    expect(body.data.mimeType).toBe("audio/webm");
    const params = new URL(body.data.url).searchParams;
    expect(verifyAudioToken(VID, params.get("exp"), params.get("token"))).toBe(
      true,
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("googlevideo");
    expect(serialized).not.toContain("decipher");
    expect(serialized).not.toContain("signature_cipher");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("bytes mode with a valid token proxies bytes (200, Accept-Ranges)", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(req(url), VID, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("audio/webm");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  test("bytes mode honors Range (206 + Content-Range)", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(
      req(url, { headers: { Range: "bytes=0-99" } }),
      VID,
      deps,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  test("bytes mode with unsatisfiable range -> 416 invalid_range", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(
      req(url, { headers: { Range: "bytes=5000-6000" } }),
      VID,
      deps,
    );
    expect(res.status).toBe(416);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_range");
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  test("invalid ranges are ignored -> 200 full body, Range never sent upstream", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    for (const range of ["bytes=100-50", "bytes=-0", "garbage"]) {
      const res = await handleAudio(
        req(url, { headers: { Range: range } }),
        VID,
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect((await res.arrayBuffer()).byteLength).toBe(1000);
    }
    // No ranged upstream fetch happened for any of them.
    expect(deps.calls).toEqual([]);
  });

  test("unknown total with a requested range -> full body as 200, no Content-Range", async () => {
    enableAudio();
    const full = new Uint8Array(1000);
    const seen: Array<ByteRange | null> = [];
    const deps: AudioDeps = {
      fetchFormat: async () => ({ mimeType: "audio/webm" }),
      fetchRange: async (_id: string, range: ByteRange | null) => {
        seen.push(range);
        if (range) {
          // Upstream honored the range but reported no total.
          return {
            bytes: full.slice(range.start, range.end ?? 999),
            contentType: "audio/webm",
            totalLength: -1,
          };
        }
        return { bytes: full, contentType: "audio/webm", totalLength: -1 };
      },
    };
    const signed = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    const { url } = (await signed.json()).data as { url: string };
    const res = await handleAudio(
      req(url, { headers: { Range: "bytes=0-99" } }),
      VID,
      deps,
    );
    // 206 is impossible without a total (Content-Range needs one), so the
    // range is dropped and the full body re-served as 200.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(seen).toEqual([{ start: 0, end: 99 }, null]);
  });

  test("expired and tampered tokens -> 403 audio_invalid_token", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const expired = mintSignedAudioUrl("http://x", VID, Date.now() - 3600_000);
    const expiredParams = new URL(expired.url).searchParams;
    const resExpired = await handleAudio(
      req(
        `http://x/api/v1/videos/${VID}/audio?token=${expiredParams.get("token")}&exp=${expiredParams.get("exp")}`,
      ),
      VID,
      deps,
    );
    expect(resExpired.status).toBe(403);
    expect((await resExpired.json()).error.code).toBe("audio_invalid_token");

    const fresh = mintSignedAudioUrl("http://x", VID);
    const freshParams = new URL(fresh.url).searchParams;
    const resTampered = await handleAudio(
      req(
        `http://x/api/v1/videos/${VID}/audio?token=00${(freshParams.get("token") ?? "").slice(2)}&exp=${freshParams.get("exp")}`,
      ),
      VID,
      deps,
    );
    expect(resTampered.status).toBe(403);
    expect((await resTampered.json()).error.code).toBe("audio_invalid_token");
  });

  test("blocked id -> 410 audio_blocked in both modes, never re-served", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    markAudioBlocked(VID);
    expect(isAudioBlocked(VID)).toBe(true);
    const resJson = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(resJson.status).toBe(410);
    expect((await resJson.json()).error.code).toBe("audio_blocked");

    const { url } = mintSignedAudioUrl("http://x", VID);
    const resBytes = await handleAudio(req(url), VID, deps);
    expect(resBytes.status).toBe(410);
    expect((await resBytes.json()).error.code).toBe("audio_blocked");
  });

  test("env-seeded blocklist (TUBELENS_AUDIO_BLOCKED_IDS) applies", async () => {
    process.env.TUBELENS_AUDIO_BLOCKED_IDS = `${OTHER}, ${VID}`;
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const res = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("audio_blocked");
  });

  test("takedown upstream -> 410 audio_unavailable and the id stays blocked", async () => {
    enableAudio();
    const deps: AudioDeps = {
      fetchFormat: async () => {
        throw new Error("NOT_FOUND: video unavailable");
      },
      fetchRange: async () => {
        throw new Error("unreachable");
      },
    };
    const res = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("audio_unavailable");
    // Never re-served afterwards (kill switch latched).
    const again = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(again.status).toBe(410);
    expect((await again.json()).error.code).toBe("audio_blocked");
  });

  test("generic upstream failure -> 502 typed hint, never bare 500", async () => {
    enableAudio();
    const deps: AudioDeps = {
      fetchFormat: async () => {
        throw new Error("socket hang up");
      },
      fetchRange: async () => {
        throw new Error("socket hang up");
      },
    };
    const res = await handleAudio(
      req(`http://x/api/v1/videos/${VID}/audio`),
      VID,
      deps,
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_degraded");
    expect(typeof body.error.hint).toBe("string");
  });

  test("invalid id -> 400, timeout -> 504 classifier", async () => {
    enableAudio();
    const deps = rangeAwareAudioDeps();
    const res = await handleAudio(req("http://x/audio"), "bad id!!", deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_video_id");
    expect(
      classifyAudioError(new Error("Upstream timed out after 8000ms")),
    ).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
  });
});

// ---------------------------------------------------------------------------
// Radio track mapping + queue assembly (pure)
// ---------------------------------------------------------------------------

describe("phase 9 radio mapping", () => {
  test("mapRadioTrack handles panel, lockup, and compact shapes; drops junk", () => {
    expect(
      mapRadioTrack({
        type: "PlaylistPanelVideo",
        video_id: "v1",
        title: "T1",
      }),
    ).toMatchObject({ id: "v1", title: "T1" });
    expect(
      mapRadioTrack({
        type: "CompactVideo",
        id: "v2",
        title: { text: "T2" },
      }),
    ).toMatchObject({ id: "v2", title: "T2" });
    expect(
      mapRadioTrack({
        content_id: "v3",
        content_type: "VIDEO",
        metadata: { title: "T3" },
      }),
    ).toMatchObject({ id: "v3", title: "T3" });
    expect(mapRadioTrack({ type: "AdBanner", id: "x" })).toBeNull();
    expect(mapRadioTrack(null)).toBeNull();
  });

  test("assembleRadioQueue dedupes, drops the seed, caps at max", () => {
    const nodes = (ids: string[]) =>
      ids.map((id) => ({
        type: "PlaylistPanelVideo",
        video_id: id,
        title: id,
      }));
    const { tracks, shortfall } = assembleRadioQueue(
      [nodes(["a", "b", "a", VID]), nodes(["b", "c"])],
      VID,
      25,
      50,
    );
    expect(tracks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(shortfall).toBe(true);
    const big = assembleRadioQueue(
      [nodes(Array.from({ length: 60 }, (_, i) => `v${i}`))],
      VID,
      25,
      50,
    );
    expect(big.tracks).toHaveLength(50);
    expect(big.shortfall).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Radio route: assembly, dedupe, cursor paging, shortfall
// ---------------------------------------------------------------------------

function node(id: string): Record<string, unknown> {
  return { type: "PlaylistPanelVideo", video_id: id, title: `Track ${id}` };
}

function fakePage(
  results: unknown[],
  next: ContinuationSearch | null,
): ContinuationSearch {
  return {
    results,
    has_continuation: next !== null,
    getContinuation: async () => {
      if (!next) {
        throw new Error("exhausted");
      }
      return next;
    },
  };
}

function radioDepsFor(ids: string[], relatedIds: string[] = []): RadioDeps {
  // Split automix ids across 3 continuation pages (12/12/rest).
  const pages: ContinuationSearch[] = [];
  const chunks = [ids.slice(0, 12), ids.slice(12, 24), ids.slice(24)];
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    pages[i] = fakePage(
      (chunks[i] ?? []).map(node),
      i + 1 < chunks.length ? (pages[i + 1] ?? null) : null,
    );
  }
  const related = fakePage(relatedIds.map(node), null);
  return {
    fetchAutomix: async () => pages[0] ?? fakePage([], null),
    continueAutomix: (page) => page.getContinuation(),
    fetchRelated: async () => related,
    continueRelated: (page) => page.getContinuation(),
  };
}

describe("phase 9 radio route", () => {
  test("assembles >= 25 deduped tracks, no repeats in the first 10", async () => {
    enableAudio();
    const ids = Array.from({ length: 30 }, (_, i) => `track${i}`);
    // Inject duplicates + the seed id across the automix chain.
    const duped = [...ids.slice(0, 12), ids[0] ?? "", ids[1] ?? "", VID];
    const deps = radioDepsFor([...duped, ...ids.slice(12)]);
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(20);
    expect(typeof body.page.next).toBe("string");
    expect(body.data.every((t: RadioTrackDTO) => t.id !== VID)).toBe(true);
    const first10 = body.data.slice(0, 10).map((t: RadioTrackDTO) => t.id);
    expect(new Set(first10).size).toBe(10);
    const allIds = body.data.map((t: RadioTrackDTO) => t.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("cursor pages the remainder with no overlap, then terminates", async () => {
    enableAudio();
    const ids = Array.from({ length: 30 }, (_, i) => `track${i}`);
    const deps = radioDepsFor(ids);
    const first = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20`),
      VID,
      deps,
    );
    const firstBody = await first.json();
    const cursor = firstBody.page.next as string;
    expect(typeof cursor).toBe("string");

    const second = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20&cursor=${cursor}`),
      VID,
      deps,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data).toHaveLength(10);
    expect(secondBody.page.next).toBeNull();
    const firstIds = new Set(firstBody.data.map((t: RadioTrackDTO) => t.id));
    for (const t of secondBody.data as RadioTrackDTO[]) {
      expect(firstIds.has(t.id)).toBe(false);
    }
  });

  test("L0-hit path re-stores a fresh cursor (no 5-min dangle on a 10-min queue)", async () => {
    enableAudio();
    const ids = Array.from({ length: 30 }, (_, i) => `track${i}`);
    const deps = radioDepsFor(ids);
    const first = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20`),
      VID,
      deps,
    );
    const staleCursor = (await first.json()).page.next as string;
    expect(typeof staleCursor).toBe("string");

    // Simulate the stored fork expiring while the queue is still L0-fresh.
    dropContinuation(staleCursor);
    const second = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20`),
      VID,
      deps,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.meta.cached).toBe(true);
    const freshCursor = secondBody.page.next as string;
    expect(typeof freshCursor).toBe("string");
    expect(freshCursor).not.toBe(staleCursor);

    // The refreshed cursor resolves the remainder.
    const third = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=20&cursor=${freshCursor}`),
      VID,
      deps,
    );
    const thirdBody = await third.json();
    expect(thirdBody.data).toHaveLength(10);
    expect(thirdBody.page.next).toBeNull();
  });

  test("related rail fills an automix shortfall", async () => {
    enableAudio();
    const deps: RadioDeps = {
      fetchAutomix: async () => fakePage(["a", "b"].map(node), null),
      continueAutomix: (page) => page.getContinuation(),
      fetchRelated: async () => fakePage(["c", "d", "e", "a"].map(node), null),
      continueRelated: (page) => page.getContinuation(),
    };
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=50`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: RadioTrackDTO) => t.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    // Still short of 25: what exists + next:null + shortfall warning.
    expect(body.page.next).toBeNull();
    expect(
      (body.warnings as Array<{ code: string }>).some(
        (w) => w.code === "radio_shortfall",
      ),
    ).toBe(true);
  });

  test("automix failure falls back to watch-next chain", async () => {
    enableAudio();
    const ids = Array.from({ length: 26 }, (_, i) => `w${i}`);
    const deps: RadioDeps = {
      fetchAutomix: async () => {
        throw new Error("automix_unavailable: RD mix missing");
      },
      continueAutomix: (page) => page.getContinuation(),
      fetchRelated: async () => fakePage(ids.map(node), null),
      continueRelated: (page) => page.getContinuation(),
    };
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=50`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(26);
  });

  test("empty everywhere -> 404 radio_unavailable; bad limit -> 400", async () => {
    enableAudio();
    const deps = radioDepsFor([], []);
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio`),
      VID,
      deps,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("radio_unavailable");

    const bad = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?limit=nope`),
      VID,
      deps,
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_limit");
  });

  test("unknown cursor -> empty page, never an error", async () => {
    enableAudio();
    const deps = radioDepsFor(["a", "b"]);
    const res = await handleRadio(
      req(`http://x/api/v1/videos/${VID}/radio?cursor=bogus`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.page.next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lyrics: timed vs plain vs unavailable
// ---------------------------------------------------------------------------

describe("phase 9 lyrics route", () => {
  test("mapLyricsShelf: timed cues -> lines with start", () => {
    const dto = mapLyricsShelf({
      timed_lyrics: [
        { start: 5, text: "hello" },
        { start: 9, text: "world" },
      ],
    });
    expect(dto?.lines).toHaveLength(2);
    expect(dto?.lines?.[0]).toMatchObject({ start: 5, text: "hello" });
    expect(dto?.text).toContain("hello");
    expect(mapLyricsShelf({ description: { text: "" } })).toBeNull();
    expect(mapLyricsShelf(null)).toBeNull();
  });

  test("mapLyricsShelf: units come from the key, never magnitude", () => {
    // A long second-valued cue must stay seconds (1800, not 2).
    const secs = mapLyricsShelf({
      timed_lyrics: [{ start: 1800, text: "late verse" }],
    });
    expect(secs?.lines?.[0]).toMatchObject({ start: 1800 });
    // Explicit ms keys divide; numeric strings work on both key kinds.
    const ms = mapLyricsShelf({
      timed_lyrics: [
        { start_ms: 5000, text: "five" },
        { startMs: "9000", text: "nine" },
        { start: "12", text: "twelve seconds" },
      ],
    });
    expect(ms?.lines?.map((l) => l.start)).toEqual([5, 9, 12]);
  });

  test("timed lyrics served with lines + text", async () => {
    enableAudio();
    const deps: LyricsDeps = {
      fetchLyrics: async () => ({
        lines: [
          { start: 5, text: "hello" },
          { start: 9, text: "world" },
        ],
        text: "hello\nworld",
      }),
    };
    const res = await handleLyrics(
      req(`http://x/api/v1/videos/${VID}/lyrics`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.text).toContain("hello");
    expect(body.page.next).toBeNull();
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
  });

  test("plain lyrics served with lines:null + text", async () => {
    enableAudio();
    const deps: LyricsDeps = {
      fetchLyrics: async () =>
        mapLyricsShelf({ description: { text: "line one\nline two" } }),
    };
    const res = await handleLyrics(
      req(`http://x/api/v1/videos/${VID}/lyrics`),
      VID,
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lines).toBeNull();
    expect(body.data.text).toContain("line one");
  });

  test("unavailable -> 404 lyrics_unavailable pointing at transcript", async () => {
    enableAudio();
    const deps: LyricsDeps = {
      fetchLyrics: async () => null,
    };
    const res = await handleLyrics(
      req(`http://x/api/v1/videos/${VID}/lyrics`),
      VID,
      deps,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("lyrics_unavailable");
    expect(body.error.hint).toContain("/videos/:id/transcript");
  });
});

// ---------------------------------------------------------------------------
// Range parsing + openapi registration
// ---------------------------------------------------------------------------

describe("phase 9 range parsing", () => {
  test("open, closed, suffix, garbage, unsatisfiable", () => {
    expect(parseRangeHeader(null, 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=0-", 1000)).toEqual({
      kind: "slice",
      start: 0,
    });
    expect(parseRangeHeader("bytes=10-99", 1000)).toEqual({
      kind: "slice",
      start: 10,
      end: 99,
    });
    expect(parseRangeHeader("bytes=-100", 1000)).toMatchObject({
      kind: "slice",
      start: 900,
    });
    expect(parseRangeHeader("garbage", 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=5000-", 1000)).toEqual({
      kind: "unsatisfiable",
    });
  });
});

describe("phase 9 openapi registration", () => {
  test("all three audio-first paths documented with operation ids", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        {
          get: {
            operationId: string;
            responses: Record<string, unknown>;
          };
        }
      >;
    };
    const expected: Record<string, string> = {
      "/videos/{id}/audio": "getAudio",
      "/videos/{id}/radio": "getRadio",
      "/videos/{id}/lyrics": "getLyrics",
    };
    for (const [path, operationId] of Object.entries(expected)) {
      expect(doc.paths[path]).toBeDefined();
      expect(doc.paths[path].get.operationId).toBe(operationId);
      const codes = Object.keys(doc.paths[path].get.responses);
      expect(codes).toContain("200");
      expect(codes).toContain("403");
    }
    const audioCodes = Object.keys(
      doc.paths["/videos/{id}/audio"].get.responses,
    );
    expect(audioCodes).toContain("410");
    expect(audioCodes).toContain("416");
    expect(audioCodes).toContain("503");
    expect(
      Object.keys(doc.paths["/videos/{id}/lyrics"].get.responses),
    ).toContain("404");
  });
});
