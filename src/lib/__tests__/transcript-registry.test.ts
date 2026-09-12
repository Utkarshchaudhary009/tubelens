import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  defaultWithTimeout,
  handleTranscript,
} from "../../app/api/v1/videos/[id]/transcript/route";
import { cacheGet, cacheSet, clearCache } from "../cache";
import { classifyTranscriptError } from "../mappers";
import {
  type FetchLike,
  filterByLang,
  langMatches,
  normalizeSegments,
  parseJson3,
  parseVtt,
  runTranscriptWaterfall,
  TRANSCRIPT_PROVIDERS,
  type TranscriptProviderDef,
} from "../transcript-providers";

beforeEach(() => {
  clearCache();
});

function req(url: string, requestId = "transcript-registry"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

interface StubResponse {
  ok: boolean;
  status: number;
  jsonBody?: unknown;
  textBody?: string;
  jsonThrows?: boolean;
  retryAfter?: string;
}

function stubRes(s: StubResponse): Awaited<ReturnType<FetchLike>> {
  const res: Awaited<ReturnType<FetchLike>> = {
    ok: s.ok,
    status: s.status,
    json: async () => {
      if (s.jsonThrows) {
        throw new Error("unexpected end of JSON input");
      }
      return s.jsonBody;
    },
    text: async () => s.textBody ?? JSON.stringify(s.jsonBody ?? null),
  };
  if (s.retryAfter !== undefined) {
    const retryAfter = s.retryAfter;
    (res as { headers?: unknown }).headers = {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? retryAfter : null,
    };
  }
  return res;
}

interface CallLog {
  url: string;
  init?: RequestInit;
}

/** fetchFn stub routing on URL substrings; records every call in order. */
function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => StubResponse,
): { fetchFn: FetchLike; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return stubRes(handler(url, init));
  };
  return { fetchFn, calls };
}

const notCalled = (): FetchLike => async () => {
  throw new Error("fetchFn must not run");
};

const nativeThrow = (msg: string) => async () => {
  throw new Error(msg);
};

const GET_TRANSCRIPT_400 = Object.assign(
  new Error(
    "Request to https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false failed with status code 400",
  ),
  { name: "InnertubeError" },
);

// ---------------------------------------------------------------------------
// Fixtures (one per provider: response -> normalize -> lang filter).
// ---------------------------------------------------------------------------

const YTTOOLS_FIXTURE = {
  videoId: "dQw4w9WgXcQ",
  transcript: [
    { text: "Hello world", offset: 1500, duration: 2500, lang: "en" },
    { text: "Second line", offset: 4000, duration: 1000, lang: "en-US" },
    { text: "Hola mundo", offset: 1500, duration: 2500, lang: "es" },
    { text: "Untagged kept", offset: 5000, duration: 500 },
    { text: "Blank tag kept", offset: 5500, duration: 500, lang: "  " },
    { text: "Malformed dropped", offset: 6000, duration: 500, lang: 42 },
    { text: "   ", offset: 6500, duration: 500, lang: "en" },
    { text: "Negative dropped", offset: -100, duration: 500, lang: "en" },
  ],
};

const VTT_SAMPLE = [
  "WEBVTT",
  "",
  "00:00:01.500 --> 00:00:04.000",
  "Hello <b>world</b>",
  "",
  "00:00:04.000 --> 00:00:05.000",
  "Hello world",
  "",
  "00:00:06.250 --> 00:00:08.750",
  "Second line",
  "",
].join("\n");

const SUBTITLES_FIXTURE = {
  title: "Never Gonna Give You Up",
  tracks: [
    {
      lang: "es",
      name: "Spanish",
      vttUrl: "https://youtube-transcript.ai/dl/es-vtt123",
    },
    { lang: "en", name: "English", vttContent: VTT_SAMPLE },
    {
      lang: "en",
      name: "English (auto)",
      vttUrl: "https://youtube-transcript.ai/dl/en-vtt456",
      json3Url: "https://youtube-transcript.ai/dl/en-json789",
    },
  ],
};

const JSON3_FIXTURE = {
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hi" }] },
    { tStartMs: 1000, segs: [] },
    {
      tStartMs: 2000,
      dDurationMs: 500,
      segs: [{ utf8: "a" }, { utf8: "b\nc" }],
    },
  ],
};

const KOME_FIXTURE = {
  transcript: "line one\nline one\n\nline two",
};

const KOME_APOLOGY = {
  transcript:
    "Sorry, transcripts aren't available for this video. Try another one.",
};

const SUPADATA_FIXTURE = {
  content: [{ text: "Whisper line", offset: 1200, duration: 800, lang: "en" }],
  lang: "en",
  availableLangs: ["en"],
};

// ---------------------------------------------------------------------------
// Contract: every def carries the full dict surface.
// ---------------------------------------------------------------------------

describe("registry contract", () => {
  test("order is innertube -> yttools -> youtube-transcript-ai -> kome -> supadata", () => {
    expect(TRANSCRIPT_PROVIDERS.map((d) => d.name)).toEqual([
      "innertube",
      "yttools",
      "youtube-transcript-ai",
      "kome",
      "supadata",
    ]);
  });

  test("every def has name/kind/method/url/parse/lang/timeoutMs/enabled", () => {
    const names = new Set<string>();
    for (const def of TRANSCRIPT_PROVIDERS) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
      expect(["native", "json", "vtt", "text"]).toContain(def.kind);
      expect(["GET", "POST"]).toContain(def.method);
      expect(typeof def.url).toBe("function");
      expect(def.url("dQw4w9WgXcQ", "en").length).toBeGreaterThan(0);
      for (const f of [
        def.parse.textField,
        def.parse.offsetField,
        def.parse.durationField,
      ]) {
        expect(typeof f).toBe("string");
        expect(f.length).toBeGreaterThan(0);
      }
      expect(["strict", "best-effort"]).toContain(def.lang);
      expect(Number.isFinite(def.timeoutMs)).toBe(true);
      expect(def.timeoutMs).toBeGreaterThan(0);
      expect(typeof def.enabled).toBe("boolean");
    }
  });

  test("only supadata is key-gated; all entries enabled by default", () => {
    for (const def of TRANSCRIPT_PROVIDERS) {
      expect(def.enabled).toBe(true);
      if (def.name === "supadata") {
        expect(def.apiKeyEnv).toBe("SUPADATA_API_KEY");
      } else {
        expect(def.apiKeyEnv).toBeUndefined();
      }
    }
  });

  test("yttools is strict, youtube-transcript-ai is best-effort", () => {
    const byName = Object.fromEntries(
      TRANSCRIPT_PROVIDERS.map((d) => [d.name, d]),
    );
    expect(byName.yttools.lang).toBe("strict");
    expect(byName["youtube-transcript-ai"].lang).toBe("best-effort");
    expect(byName.innertube.kind).toBe("native");
    expect(byName.yttools.kind).toBe("json");
    expect(byName["youtube-transcript-ai"].kind).toBe("vtt");
    expect(byName.kome.kind).toBe("text");
    expect(byName.supadata.kind).toBe("json");
  });

  test("dict-driven: a new entry needs no route edit", async () => {
    const extra: TranscriptProviderDef = {
      name: "fake",
      kind: "json",
      method: "GET",
      url: () => "https://fake.example/transcript",
      parse: {
        segmentsPath: "transcript",
        textField: "text",
        offsetField: "offset",
        durationField: "duration",
      },
      lang: "best-effort",
      timeoutMs: 1000,
      enabled: true,
    };
    const { fetchFn } = makeFetch(() => ({
      ok: true,
      status: 200,
      jsonBody: { transcript: [{ text: "hi", offset: 0, duration: 1 }] },
    }));
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow("no native"),
      fetchFn,
      providers: [extra],
    });
    expect(out).toMatchObject({ provider: "fake" });
    expect(out.segments).toEqual([
      { startSeconds: 0, durationSeconds: 0.001, text: "hi" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

describe("normalizeSegments + filterByLang", () => {
  const parse = {
    textField: "text",
    offsetField: "offset",
    durationField: "duration",
  };

  test("ms -> seconds round3; empty text / negative offsets dropped", () => {
    expect(
      normalizeSegments(
        [
          { text: "hi", offset: 1500, duration: 2500 },
          { text: "  ", offset: 0, duration: 1 },
          { text: "neg", offset: -5, duration: 1 },
          { text: "nonstr", offset: "bogus", duration: 1 },
          { text: "sec", offset: 1234.56789, duration: 0 },
        ],
        parse,
      ),
    ).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "hi" },
      { startSeconds: 1.235, text: "sec" },
    ]);
  });

  test("plain text -> single zero-timestamp deduped segment", () => {
    expect(normalizeSegments("a\na\n\nb", parse)).toEqual([
      { startSeconds: 0, text: "a\nb" },
    ]);
    expect(normalizeSegments("   \n ", parse)).toEqual([]);
    expect(normalizeSegments({ nope: true }, parse)).toEqual([]);
  });

  test("lang prefix match is _/--insensitive both ways", () => {
    expect(langMatches("en-US", "en")).toBe(true);
    expect(langMatches("en", "en-US")).toBe(true);
    expect(langMatches("en_us", "en-US")).toBe(true);
    expect(langMatches("es", "en")).toBe(false);
  });

  test("strict: untagged kept, malformed dropped, mismatch throws", () => {
    const items = YTTOOLS_FIXTURE.transcript;
    const kept = filterByLang(items, "en", "strict");
    // The lang filter judges language only: en-tagged items pass even with
    // blank text / negative offsets (normalize drops those next); the
    // malformed non-string tag is dropped here, never guessed.
    expect(kept.map((i) => (i as { text: string }).text)).toEqual([
      "Hello world",
      "Second line",
      "Untagged kept",
      "Blank tag kept",
      "   ",
      "Negative dropped",
    ]);
    expect(normalizeSegments(kept, parse).map((s) => s.text)).toEqual([
      "Hello world",
      "Second line",
      "Untagged kept",
      "Blank tag kept",
    ]);
    const allSpanish = items.filter(
      (i) => (i as { lang?: unknown }).lang === "es",
    );
    expect(() => filterByLang(allSpanish, "en", "strict")).toThrow(
      /language mismatch/,
    );
  });

  test("best-effort: matches win, else first-available", () => {
    const items = YTTOOLS_FIXTURE.transcript;
    const hits = filterByLang(items, "es", "best-effort");
    expect(hits.map((i) => (i as { text: string }).text)).toContain(
      "Hola mundo",
    );
    expect(
      hits.every(
        (i) =>
          (i as { lang?: unknown }).lang === undefined ||
          (i as { lang?: unknown }).lang === "es" ||
          ((i as { lang?: string }).lang ?? "").trim() === "",
      ),
    ).toBe(true);
    const french = filterByLang(items, "fr", "best-effort");
    expect(french.length).toBeGreaterThan(0);
    expect(french.map((i) => (i as { text: string }).text)).toContain(
      "Hola mundo",
    );
  });
});

describe("VTT / json3 parsers", () => {
  test("VTT: timestamps, tag stripping, consecutive-dupe collapse", () => {
    expect(parseVtt(VTT_SAMPLE)).toEqual([
      { offsetMs: 1500, durationMs: 2500, text: "Hello world" },
      { offsetMs: 6250, durationMs: 2500, text: "Second line" },
    ]);
  });

  test("VTT: header/NOTE/cue-less blocks skipped, bad cues dropped", () => {
    expect(
      parseVtt("WEBVTT\n\nNOTE comment\n\nno arrow here\n\nbad --> nope\nx\n"),
    ).toEqual([]);
  });

  test("json3: segs joined, empty header events dropped", () => {
    expect(parseJson3(JSON3_FIXTURE)).toEqual([
      { offsetMs: 0, durationMs: 1000, text: "hi" },
      { offsetMs: 2000, durationMs: 500, text: "ab c" },
    ]);
    expect(parseJson3({ events: "nope" })).toEqual([]);
    expect(parseJson3(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-provider fixtures through the waterfall.
// ---------------------------------------------------------------------------

describe("provider fixtures", () => {
  test("innertube fast path wins; fetchFn never runs; no provider tag", async () => {
    const segments = [{ startSeconds: 0, text: "fast" }];
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: async () => segments,
      fetchFn: notCalled(),
    });
    expect(out).toEqual({ segments });
    expect(out.provider).toBeUndefined();
  });

  test("yttools json: ms offsets + strict lang filter", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      expect(url).toContain("yttools.co/api/transcript");
      expect(url).toContain("lang=en");
      return { ok: true, status: 200, jsonBody: YTTOOLS_FIXTURE };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("yttools");
    expect(out.segments).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "Hello world" },
      { startSeconds: 4, durationSeconds: 1, text: "Second line" },
      { startSeconds: 5, durationSeconds: 0.5, text: "Untagged kept" },
      { startSeconds: 5.5, durationSeconds: 0.5, text: "Blank tag kept" },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("youtube-transcript-ai: requested track via inline vttContent", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("youtube-transcript.ai/api/subtitles")) {
        return { ok: true, status: 200, jsonBody: SUBTITLES_FIXTURE };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      // yttools fails fast so the chain reaches youtube-transcript-ai.
      fetchFn: async (url, init) => {
        if (url.includes("yttools.co")) {
          return stubRes({ ok: false, status: 422, jsonBody: {} });
        }
        return fetchFn(url, init);
      },
    });
    expect(out.provider).toBe("youtube-transcript-ai");
    expect(out.segments).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "Hello world" },
      { startSeconds: 6.25, durationSeconds: 2.5, text: "Second line" },
    ]);
    expect(calls.map((c) => c.url).join(" ")).toContain(
      "youtube-transcript.ai/api/subtitles?v=dQw4w9WgXcQ",
    );
  });

  test("youtube-transcript-ai best-effort: first track via vttUrl fetch + json3", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("/api/subtitles")) {
        return {
          ok: true,
          status: 200,
          jsonBody: {
            tracks: [
              {
                lang: "es",
                json3Url: "https://youtube-transcript.ai/dl/es.json3",
              },
            ],
          },
        };
      }
      if (url.includes("es.json3")) {
        return { ok: true, status: 200, jsonBody: JSON3_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "fr", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    // Requested French unavailable -> first (Spanish) track served.
    expect(out.provider).toBe("youtube-transcript-ai");
    expect(out.segments).toEqual([
      { startSeconds: 0, durationSeconds: 1, text: "hi" },
      { startSeconds: 2, durationSeconds: 0.5, text: "ab c" },
    ]);
  });

  test("kome text: single zero-timestamp deduped segment", async () => {
    const { fetchFn, calls } = makeFetch((url, init) => {
      expect(url).toBe("https://kome.ai/api/transcript");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)?.origin).toBe(
        "https://kome.ai",
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ format: true });
      expect(String(body.video_id)).toContain("watch?v=dQw4w9WgXcQ");
      return { ok: true, status: 200, jsonBody: KOME_FIXTURE };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: async (url, init) => {
        if (
          url.includes("yttools.co") ||
          url.includes("youtube-transcript.ai")
        ) {
          return stubRes({ ok: false, status: 422, jsonBody: {} });
        }
        return fetchFn(url, init);
      },
    });
    expect(out.provider).toBe("kome");
    expect(out.segments).toEqual([
      { startSeconds: 0, text: "line one\nline two" },
    ]);
    expect(calls.map((c) => c.url).join(" ")).toContain("kome.ai");
  });

  test("kome apology rejected, never emitted", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("kome.ai")) {
        return { ok: true, status: 200, jsonBody: KOME_APOLOGY };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "transcript_unavailable",
      status: 404,
    });
    expect(String(err)).not.toContain("aren't available");
  });

  test("supadata skipped without key; called with x-api-key when set", async () => {
    const supadata = makeFetch(() => ({
      ok: true,
      status: 200,
      jsonBody: SUPADATA_FIXTURE,
    }));
    const failing: FetchLike = async (url, init) => {
      if (url.includes("supadata.ai")) {
        return supadata.fetchFn(url, init);
      }
      return stubRes({ ok: false, status: 422, jsonBody: {} });
    };
    // No key -> supadata never hit, chain ends transcript-scoped.
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: failing,
      env: {},
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "transcript_unavailable",
    });
    expect(supadata.calls.map((c) => c.url).join(" ")).not.toContain(
      "supadata",
    );
    // Key set -> supadata serves with the key header.
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: failing,
      env: { SUPADATA_API_KEY: "secret-key" },
    });
    expect(out.provider).toBe("supadata");
    expect(out.segments).toEqual([
      { startSeconds: 1.2, durationSeconds: 0.8, text: "Whisper line" },
    ]);
    const sent = supadata.calls[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(sent?.["x-api-key"]).toBe("secret-key");
  });
});

// ---------------------------------------------------------------------------
// Waterfall behavior.
// ---------------------------------------------------------------------------

describe("waterfall", () => {
  test("order: first non-empty success wins; failures fall through in order", async () => {
    const order: string[] = [];
    const { fetchFn } = makeFetch((url) => {
      order.push(url);
      if (url.includes("yttools.co")) {
        return { ok: false, status: 422, jsonBody: {} };
      }
      if (url.includes("youtube-transcript.ai/api/subtitles")) {
        return { ok: true, status: 200, jsonBody: SUBTITLES_FIXTURE };
      }
      throw new Error(`unexpected ${url}`);
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("youtube-transcript-ai");
    expect(order[0]).toContain("yttools.co");
    expect(order[1]).toContain("youtube-transcript.ai");
    expect(order).toHaveLength(2);
  });

  test("disabled entries are skipped silently", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("youtube-transcript.ai/api/subtitles")) {
        return { ok: true, status: 200, jsonBody: SUBTITLES_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const providers: TranscriptProviderDef[] = TRANSCRIPT_PROVIDERS.map((d) =>
      d.name === "yttools" ? { ...d, enabled: false } : d,
    );
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
      providers,
    });
    expect(calls.map((c) => c.url).join(" ")).not.toContain("yttools");
    expect(out.provider).toBe("youtube-transcript-ai");
  });

  test("video_not_found short-circuits: no further providers run", async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      ok: true,
      status: 200,
      jsonBody: YTTOOLS_FIXTURE,
    }));
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow("Video deleted or removed"),
      fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "video_not_found",
      status: 404,
    });
    expect(calls).toHaveLength(0);
  });

  test("video-scoped provider body short-circuits; bare 4xx stays transcript-scoped", async () => {
    // yttools reporting a private video -> immediate video_not_found.
    const priv = makeFetch((url) => {
      if (url.includes("yttools.co")) {
        return {
          ok: false,
          status: 404,
          jsonBody: {},
          textBody: "This video is private",
        };
      }
      return { ok: true, status: 200, jsonBody: YTTOOLS_FIXTURE };
    });
    const privErr = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: priv.fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(privErr)).toMatchObject({
      code: "video_not_found",
    });
    expect(priv.calls).toHaveLength(1);

    // Bare "not found" body (no video wording) -> transcript-scoped, falls on.
    const bare = makeFetch((url) => {
      if (url.includes("yttools.co")) {
        return { ok: false, status: 404, jsonBody: {}, textBody: "not found" };
      }
      if (url.includes("kome.ai")) {
        return { ok: true, status: 200, jsonBody: KOME_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: bare.fetchFn,
    });
    expect(out.provider).toBe("kome");
  });

  test("overall budget bounds a hung fast path (no stacked per-step waits)", async () => {
    const hanging = (_id: string, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        const err = new Error("Upstream timed out after 50ms");
        err.name = "TimeoutError";
        if (signal.aborted) {
          reject(err);
          return;
        }
        // Fail-safe: the stub must settle even if the injected signal never
        // aborts (AbortSignal.timeout stalls with no other live handles under
        // bun), otherwise this test hangs the whole file forever.
        const timer = setTimeout(() => reject(err), 60);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(err);
          },
          { once: true },
        );
      });
    const started = Date.now();
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: hanging,
      fetchFn: notCalled(),
      budgetMs: 50,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
  });
});

// ---------------------------------------------------------------------------
// Route integration: cache key, provider persistence, warnings.
// ---------------------------------------------------------------------------

describe("route integration", () => {
  test("fallback success -> fallback_source warning naming the provider", async () => {
    const id = "Ff000000001";
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("yttools.co")) {
        return { ok: true, status: 200, jsonBody: YTTOOLS_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: nativeThrow(GET_TRANSCRIPT_400.message), fetchFn },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.cached).toBe(false);
    expect(body.warnings).toMatchObject([
      { code: "fallback_source", message: expect.stringContaining("yttools") },
    ]);
  });

  test("provider persists in cache: hit keeps fallback_source; lang in key", async () => {
    const id = "Ff000000002";
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("yttools.co")) {
        return { ok: true, status: 200, jsonBody: YTTOOLS_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const failingNative = nativeThrow(GET_TRANSCRIPT_400.message);
    const first = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: failingNative, fetchFn },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.warnings).toMatchObject([{ code: "fallback_source" }]);
    // Second request with a dead upstream: the cached provider entry serves,
    // still tagged with its fallback_source warning.
    const second = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: nativeThrow("boom"), fetchFn: notCalled() },
    );
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.meta.cached).toBe(true);
    expect(body.data).toEqual(firstBody.data);
    expect(body.warnings).toMatchObject([
      { code: "fallback_source", message: expect.stringContaining("yttools") },
    ]);
  });

  test("lang is part of the cache key", async () => {
    const id = "Ff000000004";
    const segments = [{ startSeconds: 0, text: "bonjour" }];
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript?lang=fr`),
      id,
      { fetchNative: async () => segments },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).meta.lang).toBe("fr");
    expect(cacheGet(`transcript:v1:${id}:fr`)).toBeDefined();
    expect(cacheGet(`transcript:v1:${id}:en`)).toBeUndefined();
  });

  test("fast path serves with no fallback_source warning", async () => {
    const id = "Ff000000003";
    const segments = [{ startSeconds: 0, text: "fast" }];
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: async () => segments },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Follow-up edge cases: remote plain-text tracks, shape errors, corrupt
// cache, and supadata request attribution.
// ---------------------------------------------------------------------------

describe("follow-up edge cases", () => {
  test("vtt: relative track URL resolved vs endpoint; plain-text body -> single deduped segment", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("/api/subtitles")) {
        return {
          ok: true,
          status: 200,
          jsonBody: { tracks: [{ lang: "en", vttUrl: "/dl/en.txt" }] },
        };
      }
      if (url.includes("/dl/en.txt")) {
        return {
          ok: true,
          status: 200,
          jsonBody: {},
          textBody: "hello\nhello\n\nworld",
        };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("youtube-transcript-ai");
    expect(out.segments).toEqual([{ startSeconds: 0, text: "hello\nworld" }]);
    // Relative vttUrl resolves against the subtitles endpoint origin
    // (yttools runs first and fails, so the track fetch is not calls[1]).
    const trackCall = calls.find((c) => c.url.includes("/dl/en.txt"));
    expect(trackCall?.url).toBe("https://youtube-transcript.ai/dl/en.txt");
    // The follow-up fetch still carries a step-abort signal (clamped to the
    // remaining step budget, never a fresh full timeout).
    expect(trackCall?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("ok response with unparsable JSON -> transcript_unavailable shape error", async () => {
    const bad: TranscriptProviderDef = {
      name: "badjson",
      kind: "json",
      method: "GET",
      url: () => "https://bad.example/transcript",
      parse: {
        segmentsPath: "transcript",
        textField: "text",
        offsetField: "offset",
        durationField: "duration",
      },
      lang: "best-effort",
      timeoutMs: 1000,
      enabled: true,
    };
    const { fetchFn } = makeFetch(() => ({
      ok: true,
      status: 200,
      jsonThrows: true,
    }));
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
      providers: [bad],
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "transcript_unavailable",
      status: 404,
    });
    expect(String(err)).toMatch(/unexpected response shape/);
  });

  test("corrupt stale cache entry normalizes to empty -> 404, never 200", async () => {
    const id = "Ff000000009";
    // Seed a corrupt entry past its fresh window: the failing upstream is
    // stale-eligible, but an empty normalization must still 404.
    cacheSet(`transcript:v1:${id}:en`, { bogus: true }, -1, 60 * 60 * 1000);
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: nativeThrow("boom"), fetchFn: notCalled() },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("transcript_unavailable");
  });

  test("supadata sends lang query param + x-api-key header", async () => {
    const supadata = makeFetch(() => ({
      ok: true,
      status: 200,
      jsonBody: SUPADATA_FIXTURE,
    }));
    const failing: FetchLike = async (url, init) => {
      if (url.includes("supadata.ai")) {
        return supadata.fetchFn(url, init);
      }
      return stubRes({ ok: false, status: 422, jsonBody: {} });
    };
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: failing,
      env: { SUPADATA_API_KEY: "secret-key" },
    });
    expect(out.provider).toBe("supadata");
    const sent = new URL(supadata.calls[0]?.url ?? "");
    expect(sent.searchParams.get("lang")).toBe("en");
    const headers = supadata.calls[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["x-api-key"]).toBe("secret-key");
  });
});

// ---------------------------------------------------------------------------
// Round-1 review fixes: single-run budget, transient status preservation,
// malformed track tags, and track-URL validation.
// ---------------------------------------------------------------------------

describe("review fixes", () => {
  test("defaultWithTimeout: import failure falls back to the local budget", async () => {
    let runs = 0;
    const out = await defaultWithTimeout(
      async () => {
        runs += 1;
        return "ok";
      },
      1000,
      async () => {
        throw new Error("Cannot find module '@/lib/youtube'");
      },
    );
    expect(out).toBe("ok");
    expect(runs).toBe(1);
  });

  test("defaultWithTimeout: waterfall rejection propagates without re-running", async () => {
    let runs = 0;
    const failure = new Error("transcript_unavailable: nothing anywhere");
    const err = await defaultWithTimeout(
      async () => {
        runs += 1;
        throw failure;
      },
      1000,
      async () => ({
        withTimeout: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
          task(AbortSignal.timeout(1000)),
      }),
    ).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBe(failure);
    expect(runs).toBe(1);
  });

  test("429 keeps rate_limited + Retry-After instead of 404", async () => {
    const { fetchFn } = makeFetch(() => ({
      ok: false,
      status: 429,
      jsonBody: {},
      retryAfter: "120",
    }));
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfter: 120,
    });
  });

  test("route: all-429 cold miss is 429 with a Retry-After header", async () => {
    const id = "Ff000000429";
    const { fetchFn } = makeFetch(() => ({
      ok: false,
      status: 429,
      jsonBody: {},
      retryAfter: "120",
    }));
    const res = await handleTranscript(
      req(`http://x/api/v1/videos/${id}/transcript`),
      id,
      { fetchNative: nativeThrow(GET_TRANSCRIPT_400.message), fetchFn },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect((await res.json()).error.code).toBe("rate_limited");
  });

  test("Retry-After: empty/blank/garbage fall back to the 60s default", async () => {
    for (const retryAfter of ["", "   ", "soon"]) {
      const { fetchFn } = makeFetch(() => ({
        ok: false,
        status: 429,
        jsonBody: {},
        retryAfter,
      }));
      const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
        fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
        fetchFn,
      }).then(
        () => {
          throw new Error("must reject");
        },
        (e: unknown) => e,
      );
      expect(classifyTranscriptError(err)).toMatchObject({
        code: "rate_limited",
        status: 429,
        retryAfter: 60,
      });
    }
  });

  test("Retry-After: HTTP-date becomes remaining seconds, clamped at 0", async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const futureFetch = makeFetch(() => ({
      ok: false,
      status: 429,
      jsonBody: {},
      retryAfter: future,
    }));
    const futureErr = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: futureFetch.fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    const classified = classifyTranscriptError(futureErr);
    expect(classified.code).toBe("rate_limited");
    expect(classified.retryAfter).toBeGreaterThan(0);
    expect(classified.retryAfter).toBeLessThanOrEqual(45);

    const pastFetch = makeFetch(() => ({
      ok: false,
      status: 429,
      jsonBody: {},
      retryAfter: "Sun, 06 Nov 1994 08:49:37 GMT",
    }));
    const pastErr = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: pastFetch.fetchFn,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(pastErr)).toMatchObject({
      code: "rate_limited",
      retryAfter: 0,
    });
  });

  test("transient 5xx with video-scoped body falls through; cold miss is 502", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("kome.ai")) {
        return { ok: true, status: 200, jsonBody: KOME_FIXTURE };
      }
      return {
        ok: false,
        status: 503,
        jsonBody: {},
        textBody: "This video is unavailable right now",
      };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("kome");

    const allDown: FetchLike = async () =>
      stubRes({
        ok: false,
        status: 503,
        jsonBody: {},
        textBody: "This video is unavailable right now",
      });
    const err = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn: allDown,
    }).then(
      () => {
        throw new Error("must reject");
      },
      (e: unknown) => e,
    );
    expect(classifyTranscriptError(err)).toMatchObject({
      code: "upstream_degraded",
      status: 502,
    });
  });

  test("malformed non-string track tags are dropped before selection", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("/api/subtitles")) {
        return {
          ok: true,
          status: 200,
          jsonBody: {
            tracks: [
              {
                lang: 42,
                vttContent:
                  "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMALFORMED",
              },
              { lang: "en", vttContent: VTT_SAMPLE },
            ],
          },
        };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    // Requested French is untagged anywhere: the malformed first track is
    // dropped, so the well-formed English track serves (never MALFORMED).
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "fr", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("youtube-transcript-ai");
    expect(out.segments).toEqual([
      { startSeconds: 1.5, durationSeconds: 2.5, text: "Hello world" },
      { startSeconds: 6.25, durationSeconds: 2.5, text: "Second line" },
    ]);
  });

  test("all-malformed track list counts as empty and falls through", async () => {
    const { fetchFn } = makeFetch((url) => {
      if (url.includes("/api/subtitles")) {
        return {
          ok: true,
          status: 200,
          jsonBody: { tracks: [{ lang: 42, vttUrl: "/dl/xx.vtt" }] },
        };
      }
      if (url.includes("kome.ai")) {
        return { ok: true, status: 200, jsonBody: KOME_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    expect(out.provider).toBe("kome");
  });

  test("off-origin and http track URLs are never fetched", async () => {
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("/api/subtitles")) {
        return {
          ok: true,
          status: 200,
          jsonBody: {
            tracks: [
              { lang: "en", vttUrl: "https://evil.example/x.vtt" },
              { lang: "en", vttUrl: "http://youtube-transcript.ai/x.vtt" },
            ],
          },
        };
      }
      if (url.includes("kome.ai")) {
        return { ok: true, status: 200, jsonBody: KOME_FIXTURE };
      }
      return { ok: false, status: 422, jsonBody: {} };
    });
    const out = await runTranscriptWaterfall("dQw4w9WgXcQ", "en", {
      fetchNative: nativeThrow(GET_TRANSCRIPT_400.message),
      fetchFn,
    });
    // The untrusted listing fails the provider; the chain falls through.
    expect(out.provider).toBe("kome");
    expect(calls.map((c) => c.url).join(" ")).not.toContain("evil.example");
  });
});
