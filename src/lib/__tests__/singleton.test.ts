import { describe, expect, test } from "bun:test";
import { createLazySingleton } from "../singleton";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLazySingleton", () => {
  test("rejected creation resets so the next get() retries", async () => {
    let calls = 0;
    const cell = createLazySingleton<string>(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve("recovered");
      },
      1000,
      "creation timed out",
    );
    await expect(cell.get()).rejects.toThrow("boom");
    await expect(cell.get()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  test("concurrent callers share one in-flight creation", async () => {
    let calls = 0;
    const gate = deferred<string>();
    const cell = createLazySingleton<string>(
      () => {
        calls += 1;
        return gate.promise;
      },
      1000,
      "creation timed out",
    );
    const p1 = cell.get();
    const p2 = cell.get();
    // create() is deferred a microtask (sync throws become rejections);
    // the cell itself is claimed synchronously, so still one attempt.
    await Promise.resolve();
    expect(calls).toBe(1);
    gate.resolve("shared");
    await expect(p1).resolves.toBe("shared");
    await expect(p2).resolves.toBe("shared");
    expect(calls).toBe(1);
  });

  test("hung creation times out and the next get() retries", async () => {
    let calls = 0;
    const cell = createLazySingleton<string>(
      () => {
        calls += 1;
        return calls === 1
          ? new Promise<string>(() => {})
          : Promise.resolve("recovered");
      },
      10,
      "creation timed out",
    );
    const err = await cell
      .get()
      .then((): unknown => null)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    await expect(cell.get()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  test("synchronous creator throw becomes a rejection and retries", async () => {
    let calls = 0;
    const cell = createLazySingleton<string>(
      () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("sync boom");
        }
        return Promise.resolve("recovered");
      },
      1000,
      "creation timed out",
    );
    await expect(cell.get()).rejects.toThrow("sync boom");
    await expect(cell.get()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  test("late rejection after a timeout win is absorbed; cell retries", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      let rejectFirst!: (e: unknown) => void;
      const cell = createLazySingleton<string>(
        () => {
          calls += 1;
          if (calls === 1) {
            return new Promise<string>((_, rej) => {
              rejectFirst = rej;
            });
          }
          return Promise.resolve("recovered");
        },
        10,
        "creation timed out",
      );
      const err = await cell
        .get()
        .then((): unknown => null)
        .catch((e: unknown) => e);
      expect((err as Error).name).toBe("TimeoutError");
      // The abandoned first attempt fails late — must not escape anywhere.
      rejectFirst(new Error("late boom"));
      await new Promise((r) => setTimeout(r, 10));
      await expect(cell.get()).resolves.toBe("recovered");
      expect(calls).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test("reset() drops the cached value", async () => {
    let calls = 0;
    const cell = createLazySingleton<string>(
      () => {
        calls += 1;
        return Promise.resolve(`v${calls}`);
      },
      1000,
      "creation timed out",
    );
    await expect(cell.get()).resolves.toBe("v1");
    await expect(cell.get()).resolves.toBe("v1");
    cell.reset();
    await expect(cell.get()).resolves.toBe("v2");
    expect(calls).toBe(2);
  });
});
