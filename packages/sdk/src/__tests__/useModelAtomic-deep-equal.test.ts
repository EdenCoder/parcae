import { describe, expect, it } from "vitest";

import { defaultEqual } from "../react/useModelAtomic";

describe("defaultEqual", () => {
  it("compares primitives with Object.is semantics", () => {
    expect(defaultEqual(1, 1)).toBe(true);
    expect(defaultEqual(NaN, NaN)).toBe(true);
    expect(defaultEqual(1, 2)).toBe(false);
    expect(defaultEqual(null, undefined)).toBe(false);
  });

  it("compares plain objects structurally", () => {
    expect(defaultEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(defaultEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(defaultEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("compares arrays structurally", () => {
    expect(defaultEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(defaultEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(defaultEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("differentiates arrays from objects", () => {
    expect(defaultEqual([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
  });

  it("walks nested values", () => {
    expect(
      defaultEqual(
        { a: { b: { c: 1 } }, d: [1, 2, 3] },
        { a: { b: { c: 1 } }, d: [1, 2, 3] },
      ),
    ).toBe(true);
    expect(
      defaultEqual(
        { a: { b: { c: 1 } } },
        { a: { b: { c: 2 } } },
      ),
    ).toBe(false);
  });
});
