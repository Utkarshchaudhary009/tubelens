import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST as revokePOST } from "../../app/api/v1/admin/keys/[keyId]/revoke/route";
import { POST as adminKeysPOST } from "../../app/api/v1/admin/keys/route";
import { PATCH as rolePATCH } from "../../app/api/v1/admin/users/[userId]/role/route";
import { PATCH as tierPATCH } from "../../app/api/v1/admin/users/[userId]/tier/route";
import { handleFeedShorts } from "../../app/api/v1/feed/shorts/route";
import {
  type HashtagDeps,
  handleHashtag,
} from "../../app/api/v1/hashtags/[tag]/route";
import {
  handleMusicSearch,
  type MusicSearchDeps,
} from "../../app/api/v1/music/search/route";
import { GET as resolveGET } from "../../app/api/v1/resolve/route";
import { handleSearch, type SearchDeps } from "../../app/api/v1/search/route";
import {
  handleSuggestions,
  type SuggestionsDeps,
} from "../../app/api/v1/search/suggestions/route";
import {
  type CommentsDeps,
  handleComments,
} from "../../app/api/v1/videos/[id]/comments/route";
import {
  handleRelated,
  type RelatedDeps,
} from "../../app/api/v1/videos/[id]/related/route";
import { handleRadio } from "../audio";
import { clearCache } from "../cache";
import { type ChannelFeedDeps, handleChannelFeed } from "../channels";
import { type ContinuationSearch, clearContinuations } from "../continuations";
import { type FeedDeps, handleFeed } from "../feed";
import {
  type ChannelPlaylistsDeps,
  handleChannelPlaylists,
  handlePlaylistFeed,
  type PlaylistFeedDeps,
} from "../playlists";
import { handleTunnelWrite, type TunnelDeps } from "../tunnel-url";
import { type BatchDeps, handleBatch } from "../utils";
import {
  MAX_BODY_BYTES,
  MAX_CURSOR_LENGTH,
  MAX_Q_LENGTH,
  MAX_URL_LENGTH,
  parseBoundedCursor,
  parseBoundedQuery,
  parseBoundedUrl,
  parseLang,
  parseLimit,
  parseRegion,
  parseSearchParams,
  parseSuggestionsParams,
  readBoundedJson,
} from "../validate";

// Part B Phase 08 — input schema and request-size validation. Every rejected
// input below must fail BEFORE any cache/upstream work: mock deps record
// calls and the tests assert they were never invoked.

const UC = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const VID = "dQw4w9WgXcQ";

beforeEach(() => {
  clearCache();
  clearContinuations();
});

// Auth/pipeline hygiene (mirrors the Phase 04/05 files): the admin 413 tests
// run in a keyless env so no Clerk credential is needed — the bounded reader
// rejects before the auth gate. Always restore so later files see clean env.
const savedEnforcement = process.env.TUBELENS_AUTH_ENFORCEMENT;
const savedSecret = process.env.CLERK_SECRET_KEY;
const savedPublishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const savedAudioFlag = process.env.TUBELENS_AUDIO_ENABLED;

afterEach(() => {
  if (savedEnforcement === undefined) {
    delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  } else {
    process.env.TUBELENS_AUTH_ENFORCEMENT = savedEnforcement;
  }
  if (savedSecret === undefined) {
    delete process.env.CLERK_SECRET_KEY;
  } else {
    process.env.CLERK_SECRET_KEY = savedSecret;
  }
  if (savedPublishable === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = savedPublishable;
  }
  if (savedAudioFlag === undefined) {
    delete process.env.TUBELENS_AUDIO_ENABLED;
  } else {
    process.env.TUBELENS_AUDIO_ENABLED = savedAudioFlag;
  }
});

function keylessEnv(): void {
  delete process.env.TUBELENS_AUTH_ENFORCEMENT;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

function getReq(url: string, requestId = "p8"): NextRequest {
  return new NextRequest(url, { headers: { "x-request-id": requestId } });
}

function postReq(
  url: string,
  body: string,
  requestId = "p8",
  method = "POST",
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body,
  });
}

/** POST with a streaming body, so no Content-Length is declared (chunked). */
function chunkedPostReq(url: string, chunks: string[]): NextRequest {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) {
        c.enqueue(enc.encode(s));
      }
      c.close();
    },
  });
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "p8-chunked",
    },
    body: stream,
    duplex: "half",
  });
}

function fakePage(): ContinuationSearch {
  return {
    results: [],
    has_continuation: false,
    getContinuation: async () => fakePage(),
  };
}

describe("phase 08 bounds (validate.ts)", () => {
  test("bound constants match the contract", () => {
    expect(MAX_Q_LENGTH).toBe(200);
    expect(MAX_CURSOR_LENGTH).toBe(2048);
    expect(MAX_URL_LENGTH).toBe(4000);
    expect(MAX_BODY_BYTES).toBe(100_000);
  });

  test("parseLimit clamp behavior is locked in (not converted to 400s)", () => {
    expect(parseLimit("200")).toBe(50);
    expect(parseLimit("9999")).toBe(50);
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("-5")).toBe(1);
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit(null)).toBe(20);
  });

  test("parseRegion/parseLang silent fallback is locked in", () => {
    expect(parseRegion("USA")).toBe("US");
    expect(parseLang("e")).toBe("en");
    expect(parseRegion("de")).toBe("DE");
  });

  test("parseBoundedQuery caps at 200 chars", () => {
    expect(parseBoundedQuery("a".repeat(200)).ok).toBe(true);
    const over = parseBoundedQuery("a".repeat(201));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("invalid_query");
      expect(over.error.status).toBe(400);
      expect(over.error.hint.length).toBeGreaterThan(5);
    }
  });

  test("parseBoundedCursor treats absent/empty as first page", () => {
    expect(parseBoundedCursor(null)).toEqual({ ok: true, value: null });
    expect(parseBoundedCursor("")).toEqual({ ok: true, value: null });
    expect(parseBoundedCursor("c".repeat(2048)).ok).toBe(true);
    const over = parseBoundedCursor("c".repeat(2049));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("invalid_cursor");
      expect(over.error.status).toBe(400);
    }
  });

  test("parseBoundedUrl caps at 4000 chars", () => {
    expect(parseBoundedUrl("https://youtu.be/x").ok).toBe(true);
    const over = parseBoundedUrl(`https://x/${"a".repeat(4000)}`);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("invalid_url");
      expect(over.error.status).toBe(400);
    }
  });

  test("parseSearchParams: missing q, unknown enum, clamped limits unchanged", () => {
    const missing = parseSearchParams(new URLSearchParams("type=video"));
    expect(!missing.ok && missing.error.code).toBe("missing_query");
    const badEnum = parseSearchParams(new URLSearchParams("q=lofi&type=song"));
    expect(!badEnum.ok && badEnum.error.code).toBe("invalid_type");
    const giant = parseSearchParams(new URLSearchParams("q=lofi&limit=200"));
    expect(giant.ok && giant.value.limit).toBe(50);
    const negative = parseSearchParams(new URLSearchParams("q=lofi&limit=-3"));
    expect(negative.ok && negative.value.limit).toBe(1);
  });

  test("parseSearchParams/parseSuggestionsParams reject overlong q", () => {
    const q = "a".repeat(201);
    const search = parseSearchParams(new URLSearchParams(`q=${q}`));
    expect(!search.ok && search.error.code).toBe("invalid_query");
    expect(!search.ok && search.error.status).toBe(400);
    const sugg = parseSuggestionsParams(new URLSearchParams(`q=${q}`));
    expect(!sugg.ok && sugg.error.code).toBe("invalid_query");
    const ok = parseSuggestionsParams(
      new URLSearchParams(`q=${"a".repeat(200)}`),
    );
    expect(ok.ok).toBe(true);
  });
});

describe("phase 08 readBoundedJson", () => {
  test("valid JSON passes through", async () => {
    const res = await readBoundedJson(
      postReq("http://x/api/v1/batch", '{"requests":[]}'),
    );
    expect(res).toEqual({ ok: true, value: { requests: [] } });
  });

  test("malformed JSON is 400 invalid_body", async () => {
    const res = await readBoundedJson(
      postReq("http://x/api/v1/batch", "{not json"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_body");
      expect(res.error.status).toBe(400);
    }
  });

  test("empty body is 400 invalid_body unless emptyValue is given", async () => {
    const denied = await readBoundedJson(postReq("http://x/api/v1/batch", ""));
    expect(!denied.ok && denied.error.code).toBe("invalid_body");
    const allowed = await readBoundedJson(
      postReq("http://x/api/v1/batch", "   "),
      { emptyValue: {} },
    );
    expect(allowed).toEqual({ ok: true, value: {} });
  });

  test("oversized Content-Length is 413 without reading", async () => {
    // Explicit oversized Content-Length with a tiny real body: the pre-check
    // must reject before the stream is consumed (bun never auto-sets the
    // header on constructed requests, so it is set by hand here — Node and
    // real proxies always declare it).
    const req = new NextRequest("http://x/api/v1/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_BODY_BYTES + 1),
        "x-request-id": "p8",
      },
      body: '{"requests":[]}',
    });
    expect(req.headers.get("content-length")).toBe(String(MAX_BODY_BYTES + 1));
    const res = await readBoundedJson(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("body_too_large");
      expect(res.error.status).toBe(413);
      expect(res.error.hint.length).toBeGreaterThan(5);
    }
  });

  test("oversized declared-length body is 413 even when bytes are present", async () => {
    const req = postReq(
      "http://x/api/v1/batch",
      `{"pad":"${"x".repeat(MAX_BODY_BYTES)}"}`,
    );
    const res = await readBoundedJson(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("body_too_large");
      expect(res.error.status).toBe(413);
    }
  });

  test("oversized chunked body (no Content-Length) is 413", async () => {
    const chunk = `{"pad":"${"x".repeat(30_000)}"}`;
    const req = chunkedPostReq("http://x/api/v1/batch", [
      chunk,
      chunk,
      chunk,
      chunk,
    ]);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await readBoundedJson(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("body_too_large");
      expect(res.error.status).toBe(413);
    }
  });

  test("body at exactly the cap parses fine", async () => {
    const pad = MAX_BODY_BYTES - '{"pad":""}'.length;
    const res = await readBoundedJson(
      postReq("http://x/api/v1/batch", `{"pad":"${"x".repeat(pad)}"}`),
    );
    expect(res.ok).toBe(true);
  });

  test("multibyte over-cap body is 413 by byte count, not char count", async () => {
    // "é" is 2 UTF-8 bytes but 1 UTF-16 code unit: 60_000 of them fit in
    // 100_000 chars yet exceed 100_000 bytes — a char-counting reader would
    // let this through.
    const body = `{"pad":"${"é".repeat(60_000)}"}`;
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(
      MAX_BODY_BYTES,
    );
    const res = await readBoundedJson(postReq("http://x/api/v1/batch", body));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("body_too_large");
      expect(res.error.status).toBe(413);
    }
  });

  test("small multibyte body still parses fine", async () => {
    const res = await readBoundedJson(
      postReq("http://x/api/v1/batch", '{"q":"héllo wörld ✓"}'),
    );
    expect(res).toEqual({ ok: true, value: { q: "héllo wörld ✓" } });
  });

  test("unparseable/negative Content-Length is treated as absent", async () => {
    for (const contentLength of ["not-a-number", "-5", ""]) {
      const req = new NextRequest("http://x/api/v1/batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": contentLength,
          "x-request-id": "p8",
        },
        body: '{"requests":[]}',
      });
      const res = await readBoundedJson(req);
      expect(res).toEqual({ ok: true, value: { requests: [] } });
    }
  });

  test("null body counts as empty", async () => {
    const bare = new NextRequest("http://x/api/v1/batch", {
      method: "POST",
      headers: { "x-request-id": "p8" },
    });
    expect(bare.body).toBeNull();
    const denied = await readBoundedJson(bare);
    expect(!denied.ok && denied.error.code).toBe("invalid_body");
    const allowed = await readBoundedJson(
      new NextRequest("http://x/api/v1/batch", {
        method: "POST",
        headers: { "x-request-id": "p8" },
      }),
      { emptyValue: {} },
    );
    expect(allowed).toEqual({ ok: true, value: {} });
  });
});

describe("phase 08 search-family q/cursor caps (no upstream on reject)", () => {
  test("search overlong q -> 400 invalid_query, upstream untouched", async () => {
    let called = false;
    const deps: SearchDeps = {
      runSearch: async () => {
        called = true;
        return fakePage();
      },
      continueSearch: async () => fakePage(),
    };
    const res = await handleSearch(
      getReq(`http://x/api/v1/search?q=${"a".repeat(201)}`),
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Request-Id")).toBe("p8");
    expect((await res.json()).error.code).toBe("invalid_query");
    expect(called).toBe(false);
  });

  test("search overlong cursor -> 400 invalid_cursor, upstream untouched", async () => {
    let runs = 0;
    const deps: SearchDeps = {
      runSearch: async () => {
        runs += 1;
        return fakePage();
      },
      continueSearch: async () => {
        runs += 1;
        return fakePage();
      },
    };
    const res = await handleSearch(
      getReq(`http://x/api/v1/search?cursor=${"c".repeat(2049)}`),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(runs).toBe(0);
  });

  test("suggestions overlong q -> 400 invalid_query, upstream untouched", async () => {
    let called = false;
    const deps: SuggestionsDeps = {
      getSuggestions: async () => {
        called = true;
        return [];
      },
    };
    const res = await handleSuggestions(
      getReq(`http://x/api/v1/search/suggestions?q=${"a".repeat(201)}`),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_query");
    expect(called).toBe(false);
  });

  test("music search overlong q/cursor -> 400, upstream untouched", async () => {
    let runs = 0;
    const deps: MusicSearchDeps = {
      runSearch: async () => {
        runs += 1;
        return {
          results: [],
          has_continuation: false,
          getContinuation: async () => {
            throw new Error("must not continue");
          },
        };
      },
      continueSearch: async () => {
        runs += 1;
        throw new Error("must not continue");
      },
    };
    const badQ = await handleMusicSearch(
      getReq(`http://x/api/v1/music/search?q=${"a".repeat(201)}`),
      deps,
    );
    expect(badQ.status).toBe(400);
    expect((await badQ.json()).error.code).toBe("invalid_query");
    const badCursor = await handleMusicSearch(
      getReq(`http://x/api/v1/music/search?cursor=${"c".repeat(2049)}`),
      deps,
    );
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json()).error.code).toBe("invalid_cursor");
    expect(runs).toBe(0);
  });

  test("comments/related overlong cursor -> 400, upstream untouched", async () => {
    let calls = 0;
    const cDeps: CommentsDeps = {
      fetchFirstPage: async () => {
        calls += 1;
        return fakePage();
      },
      continueFeed: async () => {
        calls += 1;
        return fakePage();
      },
    };
    const cRes = await handleComments(
      getReq(
        `http://x/api/v1/videos/${VID}/comments?cursor=${"c".repeat(2049)}`,
      ),
      VID,
      cDeps,
    );
    expect(cRes.status).toBe(400);
    expect((await cRes.json()).error.code).toBe("invalid_cursor");
    const rDeps: RelatedDeps = {
      fetchFirstPage: async () => {
        calls += 1;
        return fakePage();
      },
      continueFeed: async () => {
        calls += 1;
        return fakePage();
      },
    };
    const rRes = await handleRelated(
      getReq(
        `http://x/api/v1/videos/${VID}/related?cursor=${"c".repeat(2049)}`,
      ),
      VID,
      rDeps,
    );
    expect(rRes.status).toBe(400);
    expect((await rRes.json()).error.code).toBe("invalid_cursor");
    expect(calls).toBe(0);
  });

  test("resolve overlong url -> 400 invalid_url (pure, no classify work)", async () => {
    const res = await resolveGET(
      getReq(`http://x/api/v1/resolve?url=https://x/${"a".repeat(4000)}`),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_url");
  });
});

describe("phase 08 feed-family cursor caps (no upstream on reject)", () => {
  test("feed/shorts overlong cursor -> 400, upstream untouched", async () => {
    let calls = 0;
    const deps: FeedDeps = {
      fetchFirstPage: async () => {
        calls += 1;
        return fakePage();
      },
      continueFeed: async () => {
        calls += 1;
        return fakePage();
      },
    };
    const res = await handleFeed(
      getReq(`http://x/api/v1/feed/shorts?cursor=${"c".repeat(2049)}`),
      "shorts",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(calls).toBe(0);
  });

  test("feed route wrapper rejects overlong cursor too", async () => {
    let calls = 0;
    const res = await handleFeedShorts(
      getReq(`http://x/api/v1/feed/shorts?cursor=${"c".repeat(2049)}`),
      {
        fetchFirstPage: async () => {
          calls += 1;
          return fakePage();
        },
        continueFeed: async () => fakePage(),
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(calls).toBe(0);
  });

  test("channel feed overlong cursor -> 400 BEFORE address resolution", async () => {
    let resolved = 0;
    let fetched = 0;
    const deps: ChannelFeedDeps = {
      resolveChannelId: async (input) => {
        resolved += 1;
        return input;
      },
      fetchFirstPage: async () => {
        fetched += 1;
        return fakePage();
      },
      continueFeed: async () => fakePage(),
    };
    const res = await handleChannelFeed(
      getReq(
        `http://x/api/v1/channels/${UC}/videos?cursor=${"c".repeat(2049)}`,
      ),
      UC,
      "videos",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(resolved).toBe(0);
    expect(fetched).toBe(0);
  });

  test("playlist items overlong cursor -> 400, upstream untouched", async () => {
    let fetched = 0;
    const deps: PlaylistFeedDeps = {
      fetchFirstPage: async () => {
        fetched += 1;
        return fakePage();
      },
      continueFeed: async () => fakePage(),
    };
    const res = await handlePlaylistFeed(
      getReq(
        `http://x/api/v1/playlists/PLtest123/items?cursor=${"c".repeat(2049)}`,
      ),
      "PLtest123",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(fetched).toBe(0);
  });

  test("channel playlists overlong cursor -> 400 BEFORE address resolution", async () => {
    let resolved = 0;
    const deps: ChannelPlaylistsDeps = {
      resolveChannelId: async (input) => {
        resolved += 1;
        return input;
      },
      fetchFirstPage: async () => fakePage(),
      continueFeed: async () => fakePage(),
    };
    const res = await handleChannelPlaylists(
      getReq(
        `http://x/api/v1/channels/${UC}/playlists?cursor=${"c".repeat(2049)}`,
      ),
      UC,
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(resolved).toBe(0);
  });

  test("hashtag overlong cursor -> 400, upstream untouched", async () => {
    let fetched = 0;
    const deps: HashtagDeps = {
      fetchFirstPage: async () => {
        fetched += 1;
        return fakePage();
      },
      continueFeed: async () => fakePage(),
    };
    const res = await handleHashtag(
      getReq(`http://x/api/v1/hashtags/lofi?cursor=${"c".repeat(2049)}`),
      "lofi",
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(fetched).toBe(0);
  });

  test("radio overlong cursor -> 400, upstream untouched", async () => {
    process.env.TUBELENS_AUDIO_ENABLED = "1";
    let calls = 0;
    const res = await handleRadio(
      getReq(`http://x/api/v1/videos/${VID}/radio?cursor=${"c".repeat(2049)}`),
      VID,
      {
        fetchAutomix: async () => {
          calls += 1;
          return fakePage();
        },
        continueAutomix: async () => fakePage(),
        fetchRelated: async () => {
          calls += 1;
          return fakePage();
        },
        continueRelated: async () => fakePage(),
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    expect(calls).toBe(0);
  });
});

describe("phase 08 batch body caps", () => {
  const spyDeps: BatchDeps = {
    execute: async () => ({ status: 200, body: { ok: true } }),
  };

  test("11-item batch -> 400 invalid_batch, nothing executes", async () => {
    let calls = 0;
    const res = await handleBatch(
      postReq(
        "http://x/api/v1/batch",
        JSON.stringify({
          requests: Array.from({ length: 11 }, () => ({
            method: "GET",
            path: "/api/v1/health",
          })),
        }),
      ),
      {
        execute: async () => {
          calls += 1;
          return { status: 200, body: {} };
        },
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_batch");
    expect(body.error.hint).toContain("10");
    expect(calls).toBe(0);
  });

  test("malformed JSON stays 400 invalid_batch", async () => {
    const res = await handleBatch(
      postReq("http://x/api/v1/batch", "nope{"),
      spyDeps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_batch");
  });

  test("oversized body (Content-Length) -> 413 body_too_large, nothing executes", async () => {
    let calls = 0;
    const res = await handleBatch(
      postReq(
        "http://x/api/v1/batch",
        JSON.stringify({
          requests: [{ method: "GET", path: "/api/v1/health" }],
          pad: "x".repeat(MAX_BODY_BYTES),
        }),
      ),
      {
        execute: async () => {
          calls += 1;
          return { status: 200, body: {} };
        },
      },
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe("body_too_large");
    expect(body.error.hint.length).toBeGreaterThan(5);
    expect(calls).toBe(0);
  });

  test("oversized chunked body -> 413 body_too_large, nothing executes", async () => {
    let calls = 0;
    const item = `{"requests":[{"method":"GET","path":"/api/v1/health"}],"pad":"${"x".repeat(30_000)}"}`;
    const res = await handleBatch(
      chunkedPostReq("http://x/api/v1/batch", [item, item, item, item]),
      {
        execute: async () => {
          calls += 1;
          return { status: 200, body: {} };
        },
      },
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("body_too_large");
    expect(calls).toBe(0);
  });
});

describe("phase 08 tunnel-url body caps", () => {
  const url = "https://bright-fox-123.trycloudflare.com";

  function tunnelDeps(writes: unknown[]): TunnelDeps {
    return {
      store: {
        read: async () => null,
        write: async (_slot, rec) => {
          writes.push(rec);
          return rec;
        },
      },
      expectedToken: "secret-token",
    };
  }

  function writeReq(body: string, auth = "Bearer secret-token"): NextRequest {
    return new NextRequest("http://localhost/api/v1/tunnel-url", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "x-request-id": "p8-tunnel",
      },
      body,
    });
  }

  test("malformed JSON stays 400 invalid_body", async () => {
    const writes: unknown[] = [];
    const res = await handleTunnelWrite(writeReq("{nope"), tunnelDeps(writes));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
    expect(writes).toHaveLength(0);
  });

  test("oversized body -> 413 body_too_large, store untouched", async () => {
    const writes: unknown[] = [];
    const res = await handleTunnelWrite(
      writeReq(
        JSON.stringify({ name: "t3", url, runId: "x".repeat(MAX_BODY_BYTES) }),
      ),
      tunnelDeps(writes),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("body_too_large");
    expect(writes).toHaveLength(0);
  });
});

describe("phase 08 admin body caps (keyless env, parse runs before auth)", () => {
  test("admin keys create with oversized body -> 413 body_too_large", async () => {
    keylessEnv();
    const res = await adminKeysPOST(
      postReq(
        "http://x/api/v1/admin/keys",
        JSON.stringify({
          subject: "user_x",
          name: "n",
          pad: "x".repeat(MAX_BODY_BYTES),
        }),
        "p8-keys-413",
      ),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("X-Request-Id")).toBe("p8-keys-413");
    expect((await res.json()).error.code).toBe("body_too_large");
  });

  test("admin keys create with malformed JSON stays 400 invalid_body", async () => {
    keylessEnv();
    const res = await adminKeysPOST(
      postReq("http://x/api/v1/admin/keys", "{not json"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  test("revoke with oversized body -> 413; empty body still normalizes to {}", async () => {
    keylessEnv();
    const big = await revokePOST(
      postReq(
        "http://x/api/v1/admin/keys/key_1/revoke",
        JSON.stringify({ revocationReason: "x".repeat(MAX_BODY_BYTES) }),
      ),
      { params: Promise.resolve({ keyId: "key_1" }) },
    );
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("body_too_large");
    // Bare POST (no body) parses to {} and reaches the auth gate — 401 in a
    // keyless env proves the empty body was accepted, not rejected as 400.
    const bare = await revokePOST(
      new NextRequest("http://x/api/v1/admin/keys/key_1/revoke", {
        method: "POST",
        headers: { "x-request-id": "p8-revoke-bare" },
      }),
      { params: Promise.resolve({ keyId: "key_1" }) },
    );
    expect(bare.status).toBe(401);
    expect((await bare.json()).error.code).toBe("unauthenticated");
    // Non-empty malformed JSON stays 400 invalid_body.
    const garbage = await revokePOST(
      postReq("http://x/api/v1/admin/keys/key_1/revoke", "{nope"),
      { params: Promise.resolve({ keyId: "key_1" }) },
    );
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error.code).toBe("invalid_body");
  });

  test("tier/role patch with oversized body -> 413 body_too_large", async () => {
    keylessEnv();
    const tier = await tierPATCH(
      postReq(
        "http://x/api/v1/admin/users/user_x/tier",
        JSON.stringify({ tier: "pro", pad: "x".repeat(MAX_BODY_BYTES) }),
        "p8-tier-413",
        "PATCH",
      ),
      { params: Promise.resolve({ userId: "user_x" }) },
    );
    expect(tier.status).toBe(413);
    expect(tier.headers.get("X-Request-Id")).toBe("p8-tier-413");
    expect((await tier.json()).error.code).toBe("body_too_large");
    const role = await rolePATCH(
      postReq(
        "http://x/api/v1/admin/users/user_x/role",
        JSON.stringify({ role: "user", pad: "x".repeat(MAX_BODY_BYTES) }),
        "p8-role-413",
        "PATCH",
      ),
      { params: Promise.resolve({ userId: "user_x" }) },
    );
    expect(role.status).toBe(413);
    expect((await role.json()).error.code).toBe("body_too_large");
  });
});
