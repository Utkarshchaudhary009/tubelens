import { describe, expect, test } from "bun:test";
import {
  classifyVideoError,
  mapSearchItem,
  mapVideoDetails,
  textOf,
} from "../mappers";

describe("textOf", () => {
  test("plain string", () => {
    expect(textOf("hello")).toBe("hello");
  });

  test("Text object with .text", () => {
    expect(textOf({ text: "hi" })).toBe("hi");
  });

  test("runs array", () => {
    expect(textOf({ runs: [{ text: "a" }, { text: "b" }] })).toBe("ab");
  });

  test("null/undefined -> undefined", () => {
    expect(textOf(null)).toBeUndefined();
    expect(textOf(undefined)).toBeUndefined();
  });
});

describe("mapSearchItem", () => {
  test("video node maps fully", () => {
    const dto = mapSearchItem({
      type: "Video",
      id: "dQw4w9WgXcQ",
      title: { text: "Never Gonna Give You Up" },
      author: { id: "UCabc", name: "Rick" },
      thumbnails: [{ url: "https://i.yt/img.jpg", width: 120, height: 90 }],
      duration: { seconds: 213 },
      published: { text: "3 years ago" },
    });
    expect(dto).toMatchObject({
      id: "dQw4w9WgXcQ",
      kind: "video",
      title: "Never Gonna Give You Up",
      channel: { id: "UCabc", name: "Rick" },
      durationSeconds: 213,
      publishedText: "3 years ago",
    });
    expect(dto?.thumbnails?.[0]?.url).toBe("https://i.yt/img.jpg");
  });

  test("channel node maps to channel kind", () => {
    const dto = mapSearchItem({
      type: "Channel",
      id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      title: "Some Channel",
    });
    expect(dto?.kind).toBe("channel");
    expect(dto?.title).toBe("Some Channel");
  });

  test("playlist node maps to playlist kind", () => {
    const dto = mapSearchItem({
      type: "Playlist",
      playlist_id: "PL123",
      title: "Mix",
    });
    expect(dto).toMatchObject({ id: "PL123", kind: "playlist" });
  });

  test("unknown node type -> null (dropped, never crashes)", () => {
    expect(mapSearchItem({ type: "AdBanner", id: "x" })).toBeNull();
    expect(mapSearchItem({ type: "Video" })).toBeNull();
    expect(mapSearchItem(null)).toBeNull();
    expect(mapSearchItem("junk")).toBeNull();
  });

  test("never assumes fields exist", () => {
    const dto = mapSearchItem({ type: "Video", video_id: "dQw4w9WgXcQ" });
    expect(dto).toMatchObject({ id: "dQw4w9WgXcQ", title: "Untitled" });
  });
});

describe("mapVideoDetails", () => {
  test("basic_info payload maps", () => {
    const dto = mapVideoDetails({
      basic_info: {
        id: "dQw4w9WgXcQ",
        title: { text: "Never Gonna Give You Up" },
        channel_id: "UCabc",
        channel: { name: "Rick" },
        duration: 213,
        view_count: 1500000000,
        keywords: ["music", "pop"],
        thumbnails: [{ url: "https://i.yt/img.jpg" }],
      },
    });
    expect(dto).toMatchObject({
      id: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      channel: { id: "UCabc", name: "Rick" },
      durationSeconds: 213,
      viewCount: 1500000000,
      keywords: ["music", "pop"],
    });
  });

  test("compact view counts parse K/M/B multipliers", () => {
    const views = (v: unknown) =>
      mapVideoDetails({ basic_info: { id: "x", view_count: v } }).viewCount;
    expect(views("3.4M views")).toBe(3400000);
    expect(views("12K")).toBe(12000);
    expect(views("1.2B")).toBe(1200000000);
    expect(views("12,345 views")).toBe(12345);
  });

  test("digit-less count text yields no viewCount", () => {
    const dto = mapVideoDetails({
      basic_info: { id: "x", view_count: "views" },
    });
    expect(dto.viewCount).toBeUndefined();
  });

  test("empty payload degrades to Untitled, never throws", () => {
    const dto = mapVideoDetails({});
    expect(dto.title).toBe("Untitled");
    expect(dto.channel).toEqual({ id: undefined, name: undefined });
  });
});

describe("classifyVideoError", () => {
  test("NOT_FOUND -> 404 video_not_found", () => {
    expect(classifyVideoError(new Error("NOT_FOUND: video"))).toMatchObject({
      code: "video_not_found",
      status: 404,
    });
  });

  test("private/deleted wording -> 404", () => {
    expect(
      classifyVideoError(new Error("This video is private")),
    ).toMatchObject({ status: 404 });
  });

  test("LOGIN_REQUIRED -> 502 upstream_degraded", () => {
    const out = classifyVideoError(new Error("LOGIN_REQUIRED: sign in"));
    expect(out.code).toBe("upstream_degraded");
    expect(out.status).toBe(502);
    expect(out.hint.length).toBeGreaterThan(5);
  });

  test("timeout -> 504 upstream_timeout", () => {
    const err = new Error("Upstream timed out after 8000ms");
    err.name = "TimeoutError";
    expect(classifyVideoError(err)).toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
  });

  test("unknown -> 502 with hint, no stack", () => {
    const out = classifyVideoError(new Error("weird parser failure"));
    expect(out.status).toBe(502);
    expect(JSON.stringify(out)).not.toContain("at ");
  });
});
