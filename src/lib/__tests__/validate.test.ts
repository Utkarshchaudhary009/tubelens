import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMIT,
  isPlausibleVideoId,
  MAX_LIMIT,
  parseLang,
  parseLimit,
  parseRegion,
  parseSearchParams,
} from "../validate";

describe("parseLimit", () => {
  test("missing -> default 20", () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit("")).toBe(DEFAULT_LIMIT);
  });

  test("valid values pass through", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("20")).toBe(20);
    expect(parseLimit("50")).toBe(50);
  });

  test("clamps above max 50", () => {
    expect(parseLimit("100")).toBe(MAX_LIMIT);
    expect(parseLimit("9999")).toBe(MAX_LIMIT);
  });

  test("clamps below 1 up to 1", () => {
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("-5")).toBe(1);
  });

  test("garbage -> null (caller returns 400)", () => {
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit("10.5")).toBeNull();
    expect(parseLimit("10px")).toBeNull();
  });
});

describe("parseRegion / parseLang", () => {
  test("defaults", () => {
    expect(parseRegion(null)).toBe("US");
    expect(parseLang(null)).toBe("en");
  });

  test("normalizes valid values", () => {
    expect(parseRegion("de")).toBe("DE");
    expect(parseLang("EN")).toBe("en");
  });

  test("falls back on invalid", () => {
    expect(parseRegion("USA")).toBe("US");
    expect(parseLang("e")).toBe("en");
  });
});

describe("isPlausibleVideoId", () => {
  test("accepts 11-char ids and broader lengths", () => {
    expect(isPlausibleVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isPlausibleVideoId("abc12")).toBe(true);
  });

  test("rejects empty/garbage", () => {
    expect(isPlausibleVideoId("")).toBe(false);
    expect(isPlausibleVideoId("!!!")).toBe(false);
    expect(isPlausibleVideoId("has space here")).toBe(false);
  });
});

describe("parseSearchParams", () => {
  test("missing q -> missing_query 400", () => {
    for (const raw of ["", "?type=video", "?q=   "]) {
      const params = new URLSearchParams(raw.replace(/^\?/, ""));
      const res = parseSearchParams(params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("missing_query");
        expect(res.error.status).toBe(400);
        expect(res.error.hint.length).toBeGreaterThan(5);
      }
    }
  });

  test("invalid type -> invalid_type 400", () => {
    const res = parseSearchParams(new URLSearchParams("q=lofi&type=song"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_type");
      expect(res.error.status).toBe(400);
    }
  });

  test("invalid limit -> invalid_limit 400", () => {
    const res = parseSearchParams(new URLSearchParams("q=lofi&limit=many"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("invalid_limit");
    }
  });

  test("defaults + clamping", () => {
    const res = parseSearchParams(new URLSearchParams("q=lofi&limit=200"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.q).toBe("lofi");
      expect(res.value.type).toBe("all");
      expect(res.value.limit).toBe(50);
      expect(res.value.region).toBe("US");
      expect(res.value.lang).toBe("en");
    }
  });

  test("explicit values pass through", () => {
    const res = parseSearchParams(
      new URLSearchParams("q=tech&type=video&limit=5&region=DE&lang=de"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        q: "tech",
        type: "video",
        limit: 5,
        region: "DE",
        lang: "de",
      });
    }
  });
});
