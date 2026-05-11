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
 * `dedupOps(ops)` drops any op whose path lives UNDER another
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
 * Drop ops whose path lives UNDER another `remove` op in the same
 * batch. Composing helpers can produce overlapping clears — e.g.
 * one emits `remove /blocks/X/shots/Y/render` (whole render), another
 * emits `remove /blocks/X/shots/Y/render/url`. JSON-Patch applies the
 * second op against a path that no longer exists; `fast-json-patch`
 * throws. The dedup keeps only the outer remove.
 *
 * Non-remove ops under a parent-remove are also dropped (a `replace`
 * targeting a sub-path of a removed parent would fail for the same
 * reason).
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
