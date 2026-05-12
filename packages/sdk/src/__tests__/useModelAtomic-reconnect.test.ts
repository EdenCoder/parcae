/**
 * useModelAtomic — re-render gating across server-merge events.
 *
 * The hook subscribes to a Model's `"change"` event and uses
 * `useSyncExternalStore`'s snapshot diffing to skip re-renders when
 * the specific dot-path's value is unchanged.
 *
 * These tests target the contract WITHOUT mounting React. They
 * exercise the moving parts directly:
 *   - `model.on("change", cb)` is what the hook subscribes to
 *   - the hook's `getSnapshot` resolves `getAtPath(model, path)`
 *     and compares via `Object.is` (or a custom compareFn)
 *   - reference-stable returns when the comparison says "unchanged"
 *     drive React's bailout
 *
 * The hook itself is a pure function over Model + path + compareFn;
 * we simulate the `useSyncExternalStore` loop with a tiny test
 * harness that calls `subscribe()` once and tracks `getSnapshot()`
 * across change emits.
 *
 * Disconnection / reconnection scenarios are simulated by mutating
 * the model directly (or via `SYM_SERVER_MERGE` for server-side
 * updates) and asserting the snapshot before/after.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, SYM_SERVER_MERGE } from "@parcae/model";
import type { ModelAdapter, QueryChain } from "@parcae/model";

// ─── Fake adapter so Model.create / hydrate don't throw ────────────────────

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

// ─── Test model ─────────────────────────────────────────────────────────────

class Project extends Model {
  static type = "project" as const;
  title = "";
  status: "draft" | "published" = "draft";
  // Nested for dot-path tests
  video: { url: string; durationSec: number } = { url: "", durationSec: 0 };
  shots: { id: string }[] = [];
}

// ─── Test harness — mimic the hook's `useSyncExternalStore` loop ──────────

/**
 * Re-implements just enough of the hook's body to test its three
 * moving parts (subscribe / getSnapshot / Object.is bailout) without
 * the React render path.
 *
 * Returns:
 *   - `current()`: the value getSnapshot would return RIGHT NOW
 *   - `notifications`: array of values seen after each "change" emit
 *     where the hook's `useSyncExternalStore` would have re-rendered
 *   - `subscribe()`: starts listening
 *   - `unsubscribe()`: stops listening
 */
function makeHarness<V>(
  model: Model | null | undefined,
  path: string,
  compareFn?: (a: V, b: V) => boolean,
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
    const equal = compareFn
      ? prev !== undefined && next !== undefined && compareFn(prev, next)
      : Object.is(prev, next);
    if (firstSnapshot) {
      firstSnapshot = false;
      cached = next;
      return next;
    }
    if (equal) return prev;
    cached = next;
    return next;
  };

  const subscribers = new Set<() => void>();
  const onChange = () => {
    const before = cached;
    const next = computeSnapshot();
    // Mirror React's useSyncExternalStore: if the snapshot value
    // didn't change (cached identity), no re-render. Otherwise,
    // record this as a "would re-render" event.
    if (!Object.is(before, next)) {
      notifications.push(next);
    }
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
      // Initial snapshot — populate `cached` so subsequent diffs are
      // honest.
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useModelAtomic — change-event snapshot diffing", () => {
  // ── Basic snapshot reads ────────────────────────────────────────────

  it("returns the value at the dot-path on first read", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();
    expect(h.current()).toBe("x");
    h.unsubscribe();
  });

  it("returns undefined for missing dot-paths without throwing", () => {
    const p = Project.create({ title: "T1" });
    const h = makeHarness<string>(p, "video.codec");
    h.subscribe();
    expect(h.current()).toBeUndefined();
    h.unsubscribe();
  });

  it("tolerates a null model — returns undefined and never throws", () => {
    const h = makeHarness<string>(null, "video.url");
    h.subscribe();
    expect(h.current()).toBeUndefined();
    h.unsubscribe();
  });

  // ── Re-render bailout via Object.is ─────────────────────────────────

  it("does NOT re-render when the path value is unchanged across a change emit", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();
    expect(h.current()).toBe("x");

    // Mutate a DIFFERENT field; emit "change". The hook's
    // getSnapshot resolves the same `"x"` value as before → no
    // re-render.
    p.title = "T1-new";
    p.emit("change");
    expect(h.notifications).toHaveLength(0);

    h.unsubscribe();
  });

  it("re-renders when the path value changes via a direct write + change emit", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();

    // Replace the nested object — `video.url` changes to a new value.
    p.video = { url: "y", durationSec: 12 };
    p.emit("change");

    expect(h.notifications).toEqual(["y"]);
    expect(h.current()).toBe("y");
    h.unsubscribe();
  });

  // ── Server-merge path: SYM_SERVER_MERGE fires "change" ──────────────

  it("re-renders when a server merge updates the path value", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();
    expect(h.current()).toBe("x");

    // Server pushes a fresh snapshot via SYM_SERVER_MERGE — the
    // primary code path for `useQuery` re-eval after reconnect.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      video: { url: "from-server", durationSec: 12 },
      status: "draft",
      shots: [],
    });

    expect(h.notifications).toEqual(["from-server"]);
    expect(h.current()).toBe("from-server");
    h.unsubscribe();
  });

  it("does NOT re-render when a server merge writes the SAME path value", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();

    // Merge with the same url — change event still fires (the merge
    // bumps `__data` snapshot), but our path's value is identical.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1-different",
      video: { url: "x", durationSec: 12 },
      status: "draft",
      shots: [],
    });

    expect(h.notifications).toHaveLength(0);
    expect(h.current()).toBe("x");
    h.unsubscribe();
  });

  // ── compareFn override for nested-object paths ──────────────────────

  it("uses a custom compareFn so structural-equal objects don't re-render", () => {
    const p = Project.create({
      title: "T1",
      video: { url: "x", durationSec: 12 },
      shots: [{ id: "s1" }],
    });

    const deepEqual = (a: unknown[], b: unknown[]) =>
      a.length === b.length &&
      a.every(
        (x, i) => JSON.stringify(x) === JSON.stringify(b[i]),
      );

    const h = makeHarness(p, "shots", deepEqual);
    h.subscribe();
    expect(h.current()).toEqual([{ id: "s1" }]);

    // Same content, different reference — without compareFn the
    // Object.is path would re-render; with compareFn it bails.
    p.shots = [{ id: "s1" }];
    p.emit("change");
    expect(h.notifications).toHaveLength(0);

    // Now actually change the content → re-render fires.
    p.shots = [{ id: "s1" }, { id: "s2" }];
    p.emit("change");
    expect(h.notifications).toHaveLength(1);
    h.unsubscribe();
  });

  // ── Subscription cleanup ────────────────────────────────────────────

  it("unsubscribe() detaches the listener — subsequent change emits don't fire it", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();

    p.video = { url: "y", durationSec: 12 };
    p.emit("change");
    expect(h.notifications).toEqual(["y"]);

    h.unsubscribe();

    p.video = { url: "z", durationSec: 12 };
    p.emit("change");
    expect(h.notifications).toEqual(["y"]); // unchanged — listener was off
  });

  // ── Disconnect/reconnect simulation ─────────────────────────────────

  it("a disconnect (no events) leaves the snapshot untouched", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();
    expect(h.current()).toBe("x");

    // Disconnect: no change events fire. The model is still in memory
    // with its last-known state. The harness's notifications list
    // stays empty.
    expect(h.notifications).toEqual([]);
    expect(h.current()).toBe("x"); // unchanged
    h.unsubscribe();
  });

  it("after reconnect, a server merge can update the snapshot", () => {
    const p = Project.create({ title: "T1", video: { url: "stale", durationSec: 12 } });
    const h = makeHarness<string>(p, "video.url");
    h.subscribe();

    // Pretend we just reconnected and the useQuery refetch pushed
    // fresh data through SYM_SERVER_MERGE.
    (p as any)[SYM_SERVER_MERGE]({
      title: "T1",
      video: { url: "fresh-after-reconnect", durationSec: 12 },
      status: "draft",
      shots: [],
    });

    expect(h.notifications).toEqual(["fresh-after-reconnect"]);
    expect(h.current()).toBe("fresh-after-reconnect");
    h.unsubscribe();
  });

  it("multiple consumers on the same model + same path all see the update", () => {
    const p = Project.create({ title: "T1", video: { url: "x", durationSec: 12 } });
    const h1 = makeHarness<string>(p, "video.url");
    const h2 = makeHarness<string>(p, "video.url");
    h1.subscribe();
    h2.subscribe();

    p.video = { url: "y", durationSec: 12 };
    p.emit("change");

    expect(h1.notifications).toEqual(["y"]);
    expect(h2.notifications).toEqual(["y"]);

    h1.unsubscribe();
    h2.unsubscribe();
  });

  it("consumers on DIFFERENT paths only re-render for their own slice", () => {
    const p = Project.create({
      title: "T1",
      video: { url: "x", durationSec: 12 },
      status: "draft",
    });
    const hUrl = makeHarness<string>(p, "video.url");
    const hStatus = makeHarness<string>(p, "status");
    hUrl.subscribe();
    hStatus.subscribe();

    // Only video.url changes.
    p.video = { url: "y", durationSec: 12 };
    p.emit("change");
    expect(hUrl.notifications).toEqual(["y"]);
    expect(hStatus.notifications).toEqual([]);

    // Now flip status only.
    p.status = "published";
    p.emit("change");
    expect(hUrl.notifications).toEqual(["y"]); // unchanged
    expect(hStatus.notifications).toEqual(["published"]);

    hUrl.unsubscribe();
    hStatus.unsubscribe();
  });
});
