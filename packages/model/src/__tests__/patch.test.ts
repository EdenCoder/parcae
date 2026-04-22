import { describe, it, expect } from "vitest";
import { ops } from "../patch";

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
