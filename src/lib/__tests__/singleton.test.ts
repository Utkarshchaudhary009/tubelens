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
