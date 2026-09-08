import { describe, expect, test } from "bun:test";
import { classifyUrl, UnresolvableError } from "../resolve";

const VID = "dQw4w9WgXcQ";
const PL = "PL1234567890abcdef";
const CH = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

describe("classifyUrl", () => {
  test("watch URL -> video", () => {
    expect(classifyUrl(`https://www.youtube.com/watch?v=${VID}`)).toMatchObject(
      {
        type: "video",
        id: VID,
      },
    );
  });

  test("watch URL with list -> video with playlistId context", () => {
    const out = classifyUrl(
      `https://www.youtube.com/watch?v=${VID}&list=${PL}`,
    );
    expect(out.type).toBe("video");
    expect(out.id).toBe(VID);
    expect(out.playlistId).toBe(PL);
  });

  test("youtu.be -> video", () => {
    expect(classifyUrl(`https://youtu.be/${VID}`)).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("youtu.be with list -> video with playlistId", () => {
    const out = classifyUrl(`https://youtu.be/${VID}?list=${PL}`);
    expect(out.type).toBe("video");
    expect(out.playlistId).toBe(PL);
  });

  test("youtu.be with timestamp ignores t", () => {
    expect(classifyUrl(`https://youtu.be/${VID}?t=42`)).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("shorts URL -> short", () => {
    const out = classifyUrl(`https://www.youtube.com/shorts/${VID}`);
    expect(out.type).toBe("short");
    expect(out.id).toBe(VID);
    expect(out.canonicalUrl).toContain("/shorts/");
  });

  test("live URL -> live", () => {
    const out = classifyUrl(`https://www.youtube.com/live/${VID}`);
    expect(out.type).toBe("live");
    expect(out.id).toBe(VID);
  });

  test("embed URL -> video", () => {
    expect(classifyUrl(`https://www.youtube.com/embed/${VID}`)).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("legacy /v/ URL -> video", () => {
    expect(classifyUrl(`https://www.youtube.com/v/${VID}`)).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("playlist URL -> playlist", () => {
    expect(
      classifyUrl(`https://www.youtube.com/playlist?list=${PL}`),
    ).toMatchObject({
      type: "playlist",
      id: PL,
    });
  });

  test("watch URL with only list -> playlist", () => {
    expect(
      classifyUrl(`https://www.youtube.com/watch?list=${PL}`),
    ).toMatchObject({
      type: "playlist",
      id: PL,
    });
  });

  test("channel URL -> channel", () => {
    expect(classifyUrl(`https://www.youtube.com/channel/${CH}`)).toMatchObject({
      type: "channel",
      id: CH,
    });
  });

  test("@handle URL -> channel", () => {
    const out = classifyUrl("https://www.youtube.com/@somehandle");
    expect(out.type).toBe("channel");
    expect(out.id).toBe("@somehandle");
  });

  test("@handle subpath (videos) -> channel handle", () => {
    expect(
      classifyUrl("https://www.youtube.com/@somehandle/videos"),
    ).toMatchObject({
      type: "channel",
      id: "@somehandle",
    });
  });

  test("/c/ legacy name -> channel", () => {
    expect(classifyUrl("https://www.youtube.com/c/SomeChannel")).toMatchObject({
      type: "channel",
      id: "SomeChannel",
    });
  });

  test("/user/ legacy name -> channel", () => {
    expect(classifyUrl("https://www.youtube.com/user/SomeUser")).toMatchObject({
      type: "channel",
      id: "SomeUser",
    });
  });

  test("/channel/ with non-UC name throws", () => {
    expect(() =>
      classifyUrl("https://www.youtube.com/channel/SomeName"),
    ).toThrow(UnresolvableError);
  });

  test("UC-prefixed short name canonicalizes as /c/, not /channel/", () => {
    const out = classifyUrl("https://www.youtube.com/c/UCbla");
    expect(out.type).toBe("channel");
    expect(out.canonicalUrl).toBe("https://www.youtube.com/c/UCbla");
  });

  test("/user/ preserves the /user/ route in canonicalUrl", () => {
    const out = classifyUrl("https://www.youtube.com/user/SomeUser");
    expect(out.type).toBe("channel");
    expect(out.canonicalUrl).toBe("https://www.youtube.com/user/SomeUser");
  });

  test("non-http(s) protocol throws", () => {
    expect(() => classifyUrl(`ftp://www.youtube.com/watch?v=${VID}`)).toThrow(
      UnresolvableError,
    );
  });

  test("attribution_link ?u= parses the embedded watch target", () => {
    const out = classifyUrl(
      `https://www.youtube.com/attribution_link?a=xyz&u=${encodeURIComponent(`/watch?v=${VID}`)}`,
    );
    expect(out).toMatchObject({ type: "video", id: VID });
  });

  test("music.youtube.com watch -> video", () => {
    expect(
      classifyUrl(`https://music.youtube.com/watch?v=${VID}`),
    ).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("youtube-nocookie embed -> video", () => {
    expect(
      classifyUrl(`https://www.youtube-nocookie.com/embed/${VID}`),
    ).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  test("bare video id -> video", () => {
    expect(classifyUrl(VID)).toMatchObject({ type: "video", id: VID });
  });

  test("bare @handle -> channel", () => {
    expect(classifyUrl("@somehandle")).toMatchObject({
      type: "channel",
      id: "@somehandle",
    });
  });

  test("scheme-less watch URL still resolves", () => {
    expect(classifyUrl(`www.youtube.com/watch?v=${VID}`)).toMatchObject({
      type: "video",
      id: VID,
    });
  });

  const invalid = [
    ["empty string", ""],
    ["whitespace", "   "],
    ["non-YouTube host", "https://example.com/watch?v=dQw4w9WgXcQ"],
    ["non-URL garbage", "not a url at all!!!"],
    ["watch without v or list", "https://www.youtube.com/watch"],
    ["shorts without id", "https://www.youtube.com/shorts"],
    ["shorts with bad id", "https://www.youtube.com/shorts/!!!"],
    ["playlist without list", "https://www.youtube.com/playlist"],
    ["unknown path", "https://www.youtube.com/feed/trending"],
  ] as Array<[string, string]>;

  for (const [name, input] of invalid) {
    test(`invalid: ${name} -> UnresolvableError with hint`, () => {
      let caught: unknown;
      try {
        classifyUrl(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnresolvableError);
      const hint = (caught as UnresolvableError).hint;
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(10);
    });
  }
});
