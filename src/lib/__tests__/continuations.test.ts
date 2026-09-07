import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearContinuations,
  dropContinuation,
  hasContinuation,
  resolveNext,
  storeContinuation,
  takeContinuation,
} from "../continuations";

const fake = (cont: boolean) => ({
  results: [],
  has_continuation: cont,
  getContinuation: async () => {},
});

beforeEach(() => {
  clearContinuations();
});

describe("continuation store", () => {
  test("stores and resolves a live cursor", () => {
    const cursor = storeContinuation(fake(true), 0);
    if (cursor === null) {
      throw new Error("expected a cursor");
    }
    expect(resolveNext(cursor)).toBe(cursor);
    expect(hasContinuation(cursor)).toBe(true);
  });

  test("no continuation -> null cursor", () => {
    expect(storeContinuation(fake(false), 0)).toBeNull();
    expect(resolveNext(null)).toBeNull();
  });

  test("evicted/dropped cursor resolves to null (never dangles)", () => {
    const cursor = storeContinuation(fake(true), 0);
    if (cursor === null) {
      throw new Error("expected a cursor");
    }
    dropContinuation(cursor);
    expect(resolveNext(cursor)).toBeNull();
    expect(takeContinuation(cursor)).toBeUndefined();
  });

  test("unknown cursor resolves to null", () => {
    expect(resolveNext("never-minted")).toBeNull();
  });
});
