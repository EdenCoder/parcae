/**
 * useModelAtomic — default structural deep-equality.
 *
 * Validates the contract that drove the change:
 *
 *   1. After a server-merge that deep-clones the project data (the
 *      path `applyOps` in `useQuery.ts` takes for incoming update
 *      ops), every nested reference in `project.blocks` is fresh by
 *      identity but structurally identical to the prior snapshot
 *      for blocks the patch didn't touch. With the old `Object.is`
 *      default, every sub-path subscriber re-rendered on every
 *      server push — even when their slice was bit-for-bit
 *      identical. With the new structural-equal default, only
 *      subscribers whose slice ACTUALLY changed re-render.
 *
 *   2. The default still bails on primitives via `Object.is` at the
 *      top of the walk, so the hot path (leaf reads like
 *      `video.url`, `block.text`, …) stays as cheap as before.
 *
 *   3. Explicit `compareFn` still wins — passing `Object.is`
 *      restores the legacy default for one call site.
 *
 * Reuses the same `makeHarness` shape from
 * `useModelAtomic-reconnect.test.ts` but built against the real
 * `defaultEqual` export so we're testing the actual production
 * comparator, not a re-implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, SYM_SERVER_MERGE } from "@parcae/model";
import type { ModelAdapter, QueryChain } from "@parcae/model";

import { defaultEqual } from "../react/useModelAtomic";

// ─── Adapter ──────────────────────────────────────────────────────────────

function makeFakeAdapter(): ModelAdapter {
  return {
    save: vi.fn(),
    remove: vi.fn(),
    findById: vi.fn(),
    query: vi.fn(() => ({}) as QueryChain<any>),
    patch: vi.fn(),
    createStore: (data: Record<string, any>) => ({ ...data }),
  };
}

let adapter: ModelAdapter;
beforeEach(() => {
  adapter = makeFakeAdapter();
  Model.use(adapter);
});

// ─── Test model ───────────────────────────────────────────────────────────

interface BlockData {
  id: string;
  text: string;
  image?: { url?: string };
  shots?: Array<{ id: string; sketch?: { url?: string } }>;
}

class Project extends Model {
  static type = "project" as const;
  title = "";
  blocks: Record<string, BlockData> = {};
}

// ─── Harness using the REAL defaultEqual ─────────────────────────────────

function makeHarness<V>(
  model: Model | null | undefined,
  path: string,
  compareFn: (a: V, b: V) => boolean = defaultEqual as (a: V, b: V) => boolean,
) {
  let cached: V | undefined = undefined;
  let firstSnapshot = true;
  const notifications: (V | undefined)[] = [];

  const getAtPath = (obj: unknown, p: string): unknown => {
    if (obj == null || !p) return undefined;
    const parts = p.split(".");
    let cur: any = obj;
    for (const x of parts) {
      if (cur == null) return undefined;
      cur = cur[x];
    }
    return cur;
  };

  const computeSnapshot = (): V | undefined => {
    const next = model ? (getAtPath(model, path) as V) : undefined;
    const prev = cached;
    if (Object.is(prev, next)) return prev;
    if (firstSnapshot) {
      firstSnapshot = false;
      cached = next;
      return next;
    }
    if (prev === undefined || next === undefined) {
      cached = next;
      return next;
    }
    if (compareFn(prev, next)) return prev;
    cached = next;
    return next;
  };

  const subscribers = new Set<() => void>();
  const onChange = () => {
    const before = cached;
    const next = computeSnapshot();
    if (!Object.is(before, next)) notifications.push(next);
    for (const sub of subscribers) sub();
  };

  let active = false;
  return {
    current(): V | undefined {
      return computeSnapshot();
    },
    notifications,
    subscribe(): void {
      if (active) return;
      active = true;
      computeSnapshot();
      if (model && typeof model.on === "function") {
        model.on("change", onChange);
      }
    },
    unsubscribe(): void {
      if (!active) return;
      active = false;
      if (model && typeof model.off === "function") {
        model.off("change", onChange);
      }
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("useModelAtomic — default structural-equal", () => {
  // ── defaultEqual unit checks ─────────────────────────────────────────

  describe("defaultEqual", () => {
    it("returns true for identical primitives", () => {
      expect(defaultEqual(1, 1)).toBe(true);
      expect(defaultEqual("x", "x")).toBe(true);
      expect(defaultEqual(null, null)).toBe(true);
      expect(defaultEqual(undefined, undefined)).toBe(true);
      expect(defaultEqual(true, true)).toBe(true);
      // NaN special case via Object.is
      expect(defaultEqual(NaN, NaN)).toBe(true);
    });

    it("returns false across different primitives", () => {
      expect(defaultEqual(1, 2)).toBe(false);
      expect(defaultEqual("x", "y")).toBe(false);
      expect(defaultEqual(null, undefined)).toBe(false);
      expect(defaultEqual(0, false)).toBe(false);
    });

    it("compares plain objects structurally", () => {
      expect(defaultEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
      expect(defaultEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
      expect(defaultEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(defaultEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it("compares arrays structurally", () => {
      expect(defaultEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(defaultEqual([1, 2, 3], [1, 2, 4])).toBe(false);
      expect(defaultEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(defaultEqual([], [])).toBe(true);
    });

    it("differentiates arrays from objects", () => {
      expect(defaultEqual([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
    });

    it("walks nested objects", () => {
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

  // ── Server-merge cascade (the bug this whole change is fixing) ─────

  it("does NOT re-render an unchanged block's subscriber when SYM_SERVER_MERGE deep-clones the blocks map", () => {
    // Setup: project with two blocks. The sub-path subscriber
    // watches block A's text. Server pushes an update that ONLY
    // touches block B (e.g. image arrival) — but the SDK's
    // applyOps deep-clones the snapshot, so `project.blocks.A`
    // gets a fresh reference even though its content is identical.
    const p = Project.create({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta" },
      },
    });
    const h = makeHarness<BlockData>(p, "blocks.A");
    h.subscribe();
    expect(h.current()).toEqual({ id: "A", text: "alpha" });

    // Simulate the deep-clone server merge path. Block A's content
    // is unchanged but the reference IS new (post-clone). Block B
    // gets a brand new image.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta", image: { url: "u" } },
      },
    });

    // With the OLD Object.is default this would have notified.
    // With the NEW structural-equal default it bails — block A's
    // slice is bit-for-bit identical, so no re-render.
    expect(h.notifications).toHaveLength(0);
    h.unsubscribe();
  });

  it("DOES re-render the actually-changed block's subscriber", () => {
    const p = Project.create({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta" },
      },
    });
    const h = makeHarness<BlockData>(p, "blocks.B");
    h.subscribe();
    expect(h.current()).toEqual({ id: "B", text: "beta" });

    // Server adds an image to block B.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta", image: { url: "u" } },
      },
    });

    expect(h.notifications).toHaveLength(1);
    expect(h.current()).toEqual({
      id: "B",
      text: "beta",
      image: { url: "u" },
    });
    h.unsubscribe();
  });

  it("preserves reference identity for the cached snapshot across no-op merges", () => {
    const p = Project.create({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha", shots: [{ id: "s1" }] } },
    });
    const h = makeHarness<BlockData>(p, "blocks.A");
    h.subscribe();
    const first = h.current();

    // A no-op merge — the cloned block is structurally identical.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha", shots: [{ id: "s1" }] } },
    });

    // Same reference handed back — downstream `React.memo` /
    // dependency-array consumers stay quiet.
    expect(h.current()).toBe(first);
    expect(h.notifications).toHaveLength(0);
    h.unsubscribe();
  });

  it("re-renders on whole-blocks-map subscriber only when SOME block actually changed", () => {
    const p = Project.create({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta" },
      },
    });
    const h = makeHarness<Record<string, BlockData>>(p, "blocks");
    h.subscribe();
    const beforeRef = h.current();

    // No-op merge — same shape, deep-cloned. Should NOT fire.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta" },
      },
    });
    expect(h.notifications).toHaveLength(0);
    expect(h.current()).toBe(beforeRef);

    // Real change — fire.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: {
        A: { id: "A", text: "alpha" },
        B: { id: "B", text: "beta-edited" },
      },
    });
    expect(h.notifications).toHaveLength(1);
    h.unsubscribe();
  });

  // ── Explicit Object.is opt-out ──────────────────────────────────────

  it("explicit Object.is compareFn restores legacy reference-only behaviour", () => {
    const p = Project.create({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha" } },
    });
    // Pass Object.is explicitly — every server merge with a fresh
    // clone now WILL fire, which is the legacy default's behaviour.
    const h = makeHarness<BlockData>(p, "blocks.A", Object.is);
    h.subscribe();

    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha" } },
    });

    expect(h.notifications).toHaveLength(1);
    h.unsubscribe();
  });

  // ── Primitives short-circuit ────────────────────────────────────────

  it("primitives short-circuit on the Object.is fast path (no walk)", () => {
    const p = Project.create({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha" } },
    });
    const h = makeHarness<string>(p, "blocks.A.text");
    h.subscribe();
    expect(h.current()).toBe("alpha");

    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: { A: { id: "A", text: "alpha" } },
    });
    expect(h.notifications).toHaveLength(0);

    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      blocks: { A: { id: "A", text: "beta" } },
    });
    expect(h.notifications).toEqual(["beta"]);
    h.unsubscribe();
  });
});
