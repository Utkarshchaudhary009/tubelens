import { beforeEach, describe, expect, test } from "bun:test";
import { cached, cacheGet, cacheSet, clearCache } from "../cache";

beforeEach(() => {
  clearCache();
});

describe("L0 cache", () => {
  test("cold miss runs fetcher and stores", async () => {
    let calls = 0;
    const res = await cached("k1", 60_000, async () => {
      calls += 1;
      return "v";
    });
    expect(res).toMatchObject({ value: "v", hit: false, stale: false });
    expect(calls).toBe(1);
    expect(cacheGet("k1")).toMatchObject({ value: "v", stale: false });
  });

  test("fresh hit skips fetcher", async () => {
    cacheSet("k2", "cached", 60_000);
    let calls = 0;
    const res = await cached("k2", 60_000, async () => {
      calls += 1;
      return "fresh";
    });
    expect(res).toMatchObject({ value: "cached", hit: true, stale: false });
    expect(calls).toBe(0);
  });

  test("serve-stale-on-error: upstream failure returns stale copy", async () => {
    cacheSet("k3", "old", 1, 60_000);
    await new Promise((r) => setTimeout(r, 5));
    const res = await cached<string>("k3", 1, async () => {
      throw new Error("upstream down");
    });
    expect(res).toMatchObject({ value: "old", hit: true, stale: true });
  });

  test("cold miss failure propagates", async () => {
    await expect(
      cached("k4", 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("fully expired entries are dropped", async () => {
    cacheSet("k5", "x", 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(cacheGet("k5")).toBeUndefined();
  });
});
