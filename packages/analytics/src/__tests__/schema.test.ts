import { describe, expect, it } from "vitest";
import { canonicalDimensions } from "../schema.js";

describe("canonicalDimensions", () => {
  it("sorts top-level keys", () => {
    expect(canonicalDimensions({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested keys recursively", () => {
    expect(
      canonicalDimensions({ b: { y: 2, x: 1 }, a: ["k", "j"] }),
    ).toBe('{"a":["k","j"],"b":{"x":1,"y":2}}');
  });

  it("handles empty objects", () => {
    expect(canonicalDimensions({})).toBe("{}");
  });

  it("preserves array order (semantic, not sorted)", () => {
    expect(canonicalDimensions({ tiers: ["thriving", "steady", "slipping"] }))
      .toBe('{"tiers":["thriving","steady","slipping"]}');
  });
});
