/**
 * RFC 6902 JSON Patch builders + normalizer.
 *
 * `Model.patch(ops)` accepts a raw `PatchOp[]`. These helpers let you
 * build that array without hand-writing `{ op: "remove", path: "..." }`
 * objects, and scope a batch of ops under a common path prefix:
 *
 *   import { ops } from "@parcae/model";
 *
 *   // Unscoped — shortest for one-off ops.
 *   await user.patch([
 *     ops.replace("/email", "new@example.com"),
 *     ops.remove("/pending/inviteToken"),
 *   ]);
 *
 *   // Scoped — every path under a shared base.
 *   const block = ops.scope(`/blocks/${blockId}`);
 *   await project.patch([
 *     block.remove("/portrait/url"),
 *     block.remove("/portrait/approved"),
 *     block.replace("/image/approved", true),
 *   ]);
 *
 * The scoped form exists because real-world batches almost always
 * share a prefix (one block's subtree, one nested field group,
 * etc.). Without it, every caller rebuilds the same ad-hoc
 * `const rm = (p) => ({ op: "remove", path: base + p })` closure,
 * which this package has already seen in three separate apps.
 *
 * # Composition hygiene
 *
 * `dedupOps(ops)` drops any mutation whose path lives UNDER another
 * `remove` op in the same batch. This is invariant-preserving
 * normalization — when a parent gets removed, sub-path ops (whether
 * additional removes, replaces, or adds) would target a parent that
 * no longer exists. RFC 6902 says that's an error; `fast-json-patch`
 * throws. The dedup pass collapses the overlapping ops to just the
 * outer `remove`, which deletes the subtree atomically.
 *
 * `Model.patch` runs this automatically on every submitted batch —
 * consumers don't need to call it. It's exported here for tests and
 * for callers that pre-compose ops they want to inspect without
 * submission.
 */

import { applyOperation } from "fast-json-patch";
import type { PatchOp } from "./adapters/types";

/** Op builder — every method returns a ready-to-submit `PatchOp`. */
export interface OpBuilder {
  add(path: string, value: unknown): PatchOp;
  remove(path: string): PatchOp;
  replace(path: string, value: unknown): PatchOp;
  copy(from: string, path: string): PatchOp;
  move(from: string, path: string): PatchOp;
  test(path: string, value: unknown): PatchOp;
}

/** Build ops with absolute paths (no scoping). */
const unscoped: OpBuilder = {
  add: (path, value) => ({ op: "add", path, value }),
  remove: (path) => ({ op: "remove", path }),
  replace: (path, value) => ({ op: "replace", path, value }),
  copy: (from, path) => ({ op: "copy", from, path }),
  move: (from, path) => ({ op: "move", from, path }),
  test: (path, value) => ({ op: "test", path, value }),
};

/**
 * Return an op builder that prefixes every path with `base`.
 *
 * The prefix is concatenated verbatim — caller owns the leading
 * slash semantics (matches raw RFC 6902 paths, e.g. `/blocks/abc`).
 */
function scope(base: string): OpBuilder {
  return {
    add: (path, value) => ({ op: "add", path: `${base}${path}`, value }),
    remove: (path) => ({ op: "remove", path: `${base}${path}` }),
    replace: (path, value) => ({
      op: "replace",
      path: `${base}${path}`,
      value,
    }),
    copy: (from, path) => ({
      op: "copy",
      from: `${base}${from}`,
      path: `${base}${path}`,
    }),
    move: (from, path) => ({
      op: "move",
      from: `${base}${from}`,
      path: `${base}${path}`,
    }),
    test: (path, value) => ({ op: "test", path: `${base}${path}`, value }),
  };
}

/**
 * JSON Patch op builders.
 *
 * Top-level methods emit absolute-path ops. `ops.scope(base)`
 * returns a builder with the same methods that prefix every path
 * under `base` — nicer for batches touching one subtree.
 */
export const ops: OpBuilder & { scope(base: string): OpBuilder } = {
  ...unscoped,
  scope,
};

/**
 * Drop mutations whose path lives UNDER another `remove` op in the same
 * batch. Composing helpers can produce overlapping clears — e.g.
 * one emits `remove /blocks/X/shots/Y/render` (whole render), another
 * emits `remove /blocks/X/shots/Y/render/url`. JSON-Patch applies the
 * second op against a path that no longer exists; `fast-json-patch`
 * throws. The dedup keeps only the outer remove.
 *
 * Non-remove mutations under a parent-remove are also dropped (a `replace`
 * targeting a sub-path of a removed parent would fail for the same
 * reason).
 * Ordered `test` guards are always retained.
 *
 * Called automatically by `Model.patch`. Exposed for tests and
 * callers that want to inspect the post-dedup ops without
 * submitting.
 *
 * Idempotent + order-preserving among survivors.
 */
export function dedupOps(ops: readonly PatchOp[]): PatchOp[] {
  if (ops.length === 0) return ops.slice();
  const removePaths = new Set<string>();
  for (const op of ops) {
    if (op.op === "remove") removePaths.add(op.path);
  }
  if (removePaths.size === 0) return ops.slice();

  const emittedRemoves = new Set<string>();
  return ops.filter((op) => {
    if (op.op === "test") return true;
    // Drop ops whose path lives strictly UNDER any remove in the
    // batch — those would crash fast-json-patch (their parent is
    // about to be removed). Non-remove ops at the same path as a
    // remove are also dropped: a `replace` at a path being removed
    // is contradictory.
    for (const other of removePaths) {
      if (other === op.path) {
        if (op.op !== "remove") return false;
        continue;
      }
      if (op.path.startsWith(`${other}/`)) return false;
    }
    // Collapse duplicate identical removes — independent helpers
    // can emit the same remove twice; keep only the first.
    if (op.op === "remove") {
      if (emittedRemoves.has(op.path)) return false;
      emittedRemoves.add(op.path);
    }
    return true;
  });
}

// ─── Pointers ────────────────────────────────────────────────────────────────

/**
 * RFC 6901 array-index segment: a numeric string (`"0"`, `"12"`) or the append-marker `"-"`. A
 * missing intermediate before one is an array, so the array-add branch can splice into it.
 */
export function isArrayIndexSegment(seg: string | undefined): boolean {
  return seg === "-" || (seg !== undefined && /^\d+$/.test(seg));
}

export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The decoded RFC 6901 segments of a JSON Pointer. */
export function pointerSegments(path: string): string[] {
  if (!path.startsWith("/")) return [];
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// ─── Structural sharing ──────────────────────────────────────────────────────
//
// Row data is immutable. A write copies the containers on its path and keeps every other value,
// so a value that did not change keeps its identity and `===` says whether it changed.

const stamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

function container(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `ops` applied to `root` without writing to it; every value the ops do not reach keeps its identity. */
export function patched<T extends object>(root: T, ops: readonly PatchOp[]): T {
  const made = new WeakSet<object>();
  const own = (value: any): any => {
    if (made.has(value)) return value;
    const copy = Array.isArray(value) ? value.slice() : { ...value };
    made.add(copy);
    return copy;
  };
  const next = own(root);
  for (const op of ops) {
    if (op.op !== "test")
      for (const path of op.op === "move" ? [op.from, op.path] : [op.path]) {
        const segments = pointerSegments(path);
        let cursor = next;
        for (let at = 0; at < segments.length - 1; at++) {
          const child = cursor[segments[at]!];
          cursor = cursor[segments[at]!] = own(
            child !== null && typeof child === "object"
              ? child
              : isArrayIndexSegment(segments[at + 1])
                ? []
                : {},
          );
        }
      }
    applyOperation(next, op, false, true);
  }
  return next;
}

/** Whether two values hold the same data; equal references answer without a walk. */
export function same(left: any, right: any): boolean {
  if (Object.is(stamp(left), stamp(right))) return true;
  if (!container(left) || !container(right) || Array.isArray(left) !== Array.isArray(right))
    return false;
  const keys = Object.keys(right);
  return (
    keys.length === Object.keys(left).length &&
    keys.every((key) => key in left && same(left[key], right[key]))
  );
}

/** `next`, keeping every part of `previous` it equals; `previous` itself when it equals all of it. */
export function share<T>(previous: any, next: T): T {
  if (same(previous, next)) return previous;
  if (!container(previous) || !container(next) || Array.isArray(previous) !== Array.isArray(next))
    return next;
  const after: any = next;
  const made: any = Array.isArray(after) ? [...after] : { ...after };
  for (const key of Object.keys(after)) made[key] = share(previous[key], after[key]);
  return made;
}

/** The RFC 6902 ops that turn `before` into `after`; an equal reference is skipped without a walk. */
export function diff(before: unknown, after: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  const walk = (left: any, right: any, path: string): void => {
    if (Object.is(stamp(left), stamp(right))) return;
    if (!container(left) || !container(right) || Array.isArray(left) !== Array.isArray(right)) {
      ops.push({ op: "replace", path, value: right });
      return;
    }
    const keys = Object.keys(left);
    for (let at = keys.length - 1; at >= 0; at--) {
      const key = keys[at]!;
      const gone =
        !Object.prototype.hasOwnProperty.call(right, key) ||
        (right[key] === undefined && left[key] !== undefined && !Array.isArray(right));
      if (gone) ops.push({ op: "remove", path: `${path}/${encodePointerSegment(key)}` });
      else walk(left[key], right[key], `${path}/${encodePointerSegment(key)}`);
    }
    for (const key of Object.keys(right))
      if (!Object.prototype.hasOwnProperty.call(left, key) && right[key] !== undefined)
        ops.push({ op: "add", path: `${path}/${encodePointerSegment(key)}`, value: right[key] });
  };
  walk(before, after, "");
  return ops;
}
