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

  test("concurrent cold misses share one in-flight fetch", async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fetcher = async () => {
      calls += 1;
      return gate;
    };
    const pending = [
      cached("k6", 60_000, fetcher),
      cached("k6", 60_000, fetcher),
      cached("k6", 60_000, fetcher),
    ];
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    release("shared");
    const results = await Promise.all(pending);
    for (const res of results) {
      expect(res).toMatchObject({ value: "shared", stale: false });
    }
    expect(calls).toBe(1);
    expect(cacheGet("k6")).toMatchObject({ value: "shared" });
  });

  test("stale holder awaiting a coalesced fetch is served stale on failure", async () => {
    let reject!: (e: Error) => void;
    const gate = new Promise<string>((_, rej) => {
      reject = rej;
    });
    // Cold miss opens the shared in-flight fetch.
    const first = cached<string>("k8", 60_000, () => gate);
    await new Promise((r) => setTimeout(r, 5));
    // A stale copy lands while the fetch is in flight; the second caller
    // holds it and coalesces onto the same fetch.
    cacheSet("k8", "stale-copy", 1, 60_000);
    await new Promise((r) => setTimeout(r, 5));
    const second = cached<string>("k8", 1, () => gate);
    reject(new Error("upstream down"));
    // Cold-miss opener has no stale: still throws.
    await expect(first).rejects.toThrow("upstream down");
    // Stale-holding joiner gets the stale copy instead of the throw.
    await expect(second).resolves.toMatchObject({
      value: "stale-copy",
      hit: true,
      stale: true,
    });
  });

  test("capacity: oldest entry evicted at MAX_SIZE, size stays bounded", async () => {
    for (let i = 0; i < 500; i += 1) {
      cacheSet(`cap-${i}`, i, 60_000);
    }
    expect(cacheGet("cap-0")).toMatchObject({ value: 0 });
    cacheSet("cap-new", "new", 60_000);
    expect(cacheGet("cap-0")).toBeUndefined();
    expect(cacheGet("cap-1")).toMatchObject({ value: 1 });
    expect(cacheGet("cap-new")).toMatchObject({ value: "new" });
  });

  test("refreshing an existing key at capacity evicts nothing", async () => {
    for (let i = 0; i < 500; i += 1) {
      cacheSet(`ref-${i}`, i, 60_000);
    }
    cacheSet("ref-499", "refreshed", 60_000);
    expect(cacheGet("ref-499")).toMatchObject({ value: "refreshed" });
    expect(cacheGet("ref-0")).toMatchObject({ value: 0 });
  });

  test("isRetryable=false errors never serve stale", async () => {
    cacheSet("k9", "old", 1, 60_000);
    await new Promise((r) => setTimeout(r, 5));
    const never = () => false;
    await expect(
      cached<string>(
        "k9",
        1,
        async () => {
          throw new Error("NOT_FOUND");
        },
        60_000,
        never,
      ),
    ).rejects.toThrow("NOT_FOUND");
    const res = await cached<string>(
      "k9",
      1,
      async () => {
        throw new Error("timeout");
      },
      60_000,
      () => true,
    );
    expect(res).toMatchObject({ value: "old", hit: true, stale: true });
  });

  test("failed fetch clears the in-flight slot so the next call retries", async () => {
    let calls = 0;
    await expect(
      cached("k7", 60_000, async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const res = await cached("k7", 60_000, async () => {
      calls += 1;
      return "recovered";
    });
    expect(res).toMatchObject({ value: "recovered", hit: false });
    expect(calls).toBe(2);
  });
});
