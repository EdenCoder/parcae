import { describe, it, expect } from "vitest";
import { dedupOps, ops } from "../patch";
import { orderEmissionDisabled, type PatchOp } from "../adapters/types";

describe("ops (unscoped builders)", () => {
  it("builds a remove op", () => {
    expect(ops.remove("/foo/bar")).toEqual({ op: "remove", path: "/foo/bar" });
  });

  it("builds a replace op with a value", () => {
    expect(ops.replace("/foo/bar", 42)).toEqual({
      op: "replace",
      path: "/foo/bar",
      value: 42,
    });
  });

  it("builds an add op", () => {
    expect(ops.add("/list/-", "new")).toEqual({
      op: "add",
      path: "/list/-",
      value: "new",
    });
  });

  it("builds copy / move / test ops", () => {
    expect(ops.copy("/a", "/b")).toEqual({
      op: "copy",
      from: "/a",
      path: "/b",
    });
    expect(ops.move("/a", "/b")).toEqual({
      op: "move",
      from: "/a",
      path: "/b",
    });
    expect(ops.test("/a", 1)).toEqual({ op: "test", path: "/a", value: 1 });
  });
});

describe("ops.scope", () => {
  it("prefixes every path with the base", () => {
    const block = ops.scope("/blocks/abc");
    expect(block.remove("/portrait/url")).toEqual({
      op: "remove",
      path: "/blocks/abc/portrait/url",
    });
    expect(block.replace("/portrait/approved", true)).toEqual({
      op: "replace",
      path: "/blocks/abc/portrait/approved",
      value: true,
    });
  });

  it("prefixes both paths of copy / move", () => {
    const block = ops.scope("/blocks/abc");
    expect(block.copy("/a", "/b")).toEqual({
      op: "copy",
      from: "/blocks/abc/a",
      path: "/blocks/abc/b",
    });
    expect(block.move("/a", "/b")).toEqual({
      op: "move",
      from: "/blocks/abc/a",
      path: "/blocks/abc/b",
    });
  });

  it("produces independent builders per scope call", () => {
    const a = ops.scope("/a");
    const b = ops.scope("/b");
    expect(a.remove("/x").path).toBe("/a/x");
    expect(b.remove("/x").path).toBe("/b/x");
  });

  it("concatenates the base verbatim — caller owns leading slashes", () => {
    // No magic — scope prefix + path is raw string concat, so an
    // empty-string path yields just the base.
    const s = ops.scope("/root");
    expect(s.remove("").path).toBe("/root");
  });
});

describe("dedupOps", () => {
  it("drops sub-field removes under a parent remove", () => {
    const input: PatchOp[] = [
      { op: "remove", path: "/blocks/X/shots/Y/render" },
      { op: "remove", path: "/blocks/X/shots/Y/render/url" },
      { op: "remove", path: "/blocks/X/shots/Y/render/duration" },
    ];
    const out = dedupOps(input);
    expect(out).toEqual([
      { op: "remove", path: "/blocks/X/shots/Y/render" },
    ]);
  });

  it("preserves siblings under the same parent", () => {
    const input: PatchOp[] = [
      { op: "remove", path: "/blocks/X/shots/Y/render" },
      { op: "remove", path: "/blocks/X/shots/Y/sketch" },
      { op: "remove", path: "/blocks/X/shots/Y/panel" },
    ];
    const out = dedupOps(input);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.path)).toEqual([
      "/blocks/X/shots/Y/render",
      "/blocks/X/shots/Y/sketch",
      "/blocks/X/shots/Y/panel",
    ]);
  });

  it("drops non-remove ops under a parent-remove (would crash applyPatch)", () => {
    // The whole point: fast-json-patch throws when an op targets a
    // path whose parent was just removed in the same batch. Dedup
    // collapses these so callers can freely compose helpers without
    // having to know the cleanup order.
    const input: PatchOp[] = [
      { op: "remove", path: "/blocks/X/image" },
      { op: "replace", path: "/blocks/X/image/url", value: "foo" },
      { op: "add", path: "/blocks/X/image/hash", value: "deadbeef" },
    ];
    const out = dedupOps(input);
    expect(out).toEqual([{ op: "remove", path: "/blocks/X/image" }]);
  });

  it("collapses duplicate identical removes to one", () => {
    const input: PatchOp[] = [
      { op: "remove", path: "/a" },
      { op: "remove", path: "/a" },
      { op: "remove", path: "/a" },
    ];
    const out = dedupOps(input);
    expect(out).toEqual([{ op: "remove", path: "/a" }]);
  });

  it("preserves non-overlapping ops in order", () => {
    const input: PatchOp[] = [
      { op: "replace", path: "/a", value: 1 },
      { op: "remove", path: "/b/x" },
      { op: "add", path: "/c", value: 2 },
    ];
    const out = dedupOps(input);
    expect(out).toEqual(input);
  });

  it("returns empty for empty input", () => {
    expect(dedupOps([])).toEqual([]);
  });

  it("is a no-op when no removes are present", () => {
    const input: PatchOp[] = [
      { op: "replace", path: "/a", value: 1 },
      { op: "add", path: "/b", value: 2 },
    ];
    const out = dedupOps(input);
    expect(out).toEqual(input);
  });
});

describe("orderEmissionDisabled", () => {
  it("uses the last orderBy call when false comes last", () => {
    expect(
      orderEmissionDisabled([
        { method: "orderBy", args: ["createdAt", "desc"] },
        { method: "orderBy", args: [false] },
      ]),
    ).toBe(true);
  });

  it("re-enables order emission when a column order comes last", () => {
    expect(
      orderEmissionDisabled([
        { method: "orderBy", args: [false] },
        { method: "orderBy", args: ["createdAt", "desc"] },
      ]),
    ).toBe(false);
  });
});
