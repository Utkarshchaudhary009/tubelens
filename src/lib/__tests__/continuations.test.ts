import { beforeEach, describe, expect, test } from "bun:test";
import {
  type ContinuationEntry,
  clearContinuations,
  dropContinuation,
  forkContinuation,
  hasContinuation,
  hasMoreResults,
  resolveNext,
  storeContinuation,
  takeContinuation,
} from "../continuations";

const fake = (cont: boolean) => ({
  results: [],
  has_continuation: cont,
  getContinuation: async () => fake(false),
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

  test("entry with buffered remainder but no continuation is stored", () => {
    const cursor = storeContinuation({ ...fake(false), results: [{}, {}] }, 1);
    if (cursor === null) {
      throw new Error("expected a cursor for buffered remainder");
    }
    const entry = takeContinuation(cursor) as ContinuationEntry;
    expect(hasMoreResults(entry)).toBe(true);
  });

  test("fork mints an independent cursor from a live one", () => {
    const source = {
      results: [{ id: 1 }],
      has_continuation: true,
      getContinuation: async () => fake(false),
    };
    const original = storeContinuation(source, 1);
    if (original === null) {
      throw new Error("expected a cursor");
    }
    const forked = forkContinuation(original);
    if (forked === null) {
      throw new Error("expected a forked cursor");
    }
    expect(forked).not.toBe(original);
    // Independent entries: advancing the fork leaves the source offset alone.
    const forkEntry = takeContinuation(forked) as ContinuationEntry;
    const sourceEntry = takeContinuation(original) as ContinuationEntry;
    expect(forkEntry).not.toBe(sourceEntry);
    forkEntry.returned += 1;
    expect(sourceEntry.returned).toBe(1);
    expect(forkEntry.search.results).toEqual(sourceEntry.search.results);
  });

  test("fork of a buffered-remainder-only source stays live (miss/hit agree)", () => {
    // Single upstream page larger than the served limit: no continuation, but
    // items remain buffered — the miss serves a cursor, so the hit must fork
    // one too instead of null.
    const original = storeContinuation(
      { ...fake(false), results: [{}, {}] },
      1,
    );
    if (original === null) {
      throw new Error("expected a cursor for buffered remainder");
    }
    const forked = forkContinuation(original);
    if (forked === null) {
      throw new Error("expected a forked cursor for buffered remainder");
    }
    expect(forked).not.toBe(original);
    expect(resolveNext(forked)).toBe(forked);
  });

  test("fork of unknown/dropped/exhausted source is null", () => {
    expect(forkContinuation(null)).toBeNull();
    expect(forkContinuation("never-minted")).toBeNull();
    const dead = storeContinuation({ ...fake(false), results: [{}] }, 1);
    expect(dead).toBeNull();
    const nocont = storeContinuation(fake(false), 0);
    expect(nocont).toBeNull();
    const live = storeContinuation(fake(true), 0);
    if (live === null) {
      throw new Error("expected a cursor");
    }
    dropContinuation(live);
    expect(forkContinuation(live)).toBeNull();
  });
});
