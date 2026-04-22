/**
 * RFC 6902 JSON Patch builders.
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
