/**
 * useQuery — items-array reference contract.
 *
 * `applyOps` is the function that takes a subscription op batch and
 * produces the next cache `items` array. It has three distinct
 * reference-stability regimes that downstream consumers depend on:
 *
 *   1. No-op batch (empty ops, or ops that don't touch any item in
 *      the result set) → return the SAME items reference. Skips
 *      every downstream invalidation. Critical for hot paths where
 *      a subscription receives a flood of ops for items not in our
 *      query result.
 *
 *   2. Update-only batch (one or more `op: "update"` matches; no
 *      adds / no removes) → return a NEW items array reference,
 *      shallow-copied. Per-item Model instances inside the new
 *      array are the SAME references as before (`SYM_SERVER_MERGE`
 *      mutates in place). The new array reference is what
 *      downstream `useMemo([items])` and `useEffect([items])`
 *      consumers need to see in order to recompute / re-fire. The
 *      per-item identity is what `React.memo(Row, item)` relies
 *      on to short-circuit unchanged rows. This is the
 *      "items.slice() invariant" introduced by the upstream
 *      veb fix (`fix(sdk): rebuild items array on update-only ops
 *      so downstream useMemo invalidates`).
 *
 *   3. Add / remove batch → return a fresh items array built from
 *      scratch. New reference, new membership.
 *
 * These tests pin the three regimes directly via the public
 * subscription path: a `FakeClient` emits ops, `applyOps` runs
 * inside the subscription handler, and we inspect `entry.items`
 * before and after.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { __test as useQueryTest } from "../react/useQuery";

// ─── Fake Model class ───────────────────────────────────────────────────────

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

// ─── FakeClient — minimal ParcaeClient surface useQuery touches ─────────────

interface SubscriptionRegistration {
  event: string;
  handler: (...args: any[]) => void;
}

class FakeClient extends EventEmitter {
  public subscriptions: SubscriptionRegistration[] = [];

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const entry = { event, handler };
    this.subscriptions.push(entry);
    return () => {
      const idx = this.subscriptions.indexOf(entry);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  emitQueryOps(hash: string, ops: unknown[]): void {
    for (const sub of this.subscriptions) {
      if (sub.event === `query:${hash}`) sub.handler(ops);
    }
  }
}

// ─── chain factory ──────────────────────────────────────────────────────────

function makeChain(opts: {
  results: Array<{ id: string; title?: string; body?: string }>;
  queryHash: string;
}): any {
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
  };

  chain.find = async () => {
    const items = opts.results.map((r) => Post.hydrate({} as any, r));
    Object.defineProperty(items, "__queryHash", {
      value: opts.queryHash,
      enumerable: false,
    });
    Object.defineProperty(items, "__totalCount", {
      value: opts.results.length,
      enumerable: false,
    });
    return items;
  };

  return chain;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function primeCache(
  client: FakeClient,
  hash: string,
  results: Array<{ id: string; title?: string; body?: string }>,
) {
  const chain = makeChain({ results, queryHash: hash });
  const key = useQueryTest.buildKey("post", "u1", chain.__steps);
  const release = useQueryTest.retain(key, () => {});
  useQueryTest.fetch(key, chain, client as any);
  await new Promise((r) => setImmediate(r));
  const entry = useQueryTest.getEntry(key)!;
  return { entry, release };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useQuery — items-array reference contract", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });
  afterEach(() => {
    useQueryTest.resetCache();
  });

  // ── 1. Update-only ops: NEW array reference, SAME per-item refs ───

  it("update-only op returns a NEW items array reference (shallow copy)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-update", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    const beforeArray = entry.items;
    const beforeP1 = entry.items[0];
    const beforeP2 = entry.items[1];

    client.emitQueryOps("h-update", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "updated" }],
      },
    ]);

    // The wrapping array MUST be a new reference so downstream
    // `useMemo([items])` and `useEffect([items])` consumers see a
    // dep change and recompute / re-fire. This is the load-bearing
    // invariant from the upstream `items.slice()` fix.
    expect(entry.items).not.toBe(beforeArray);

    // Per-item Model identity stays stable — only the wrapping
    // array is fresh. Critical so `React.memo(Row, prevItem ===
    // nextItem)` short-circuits cleanly for unchanged rows.
    expect(entry.items[0]).toBe(beforeP1);
    expect(entry.items[1]).toBe(beforeP2);

    // The mutation actually landed on the in-place model.
    expect(entry.items[0].title).toBe("updated");
    // Untouched item is unchanged.
    expect(entry.items[1].title).toBe("second");

    // Version bumps on changed=true so useSyncExternalStore fires.
    expect(entry.version).toBe(1);

    release();
  });

  it("multiple update ops in one batch still return a single shallow-copied array", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-multi", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
      { id: "p3", title: "third" },
    ]);

    const beforeArray = entry.items;
    const beforeRefs = entry.items.slice();

    client.emitQueryOps("h-multi", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "A" }],
      },
      {
        op: "update",
        id: "p3",
        patch: [{ op: "replace", path: "/title", value: "C" }],
      },
    ]);

    expect(entry.items).not.toBe(beforeArray);
    expect(entry.items).toHaveLength(3);
    // Per-item identity preserved across the whole batch.
    for (let i = 0; i < 3; i++) {
      expect(entry.items[i]).toBe(beforeRefs[i]);
    }
    expect(entry.items[0].title).toBe("A");
    expect(entry.items[1].title).toBe("second");
    expect(entry.items[2].title).toBe("C");

    release();
  });

  // ── 2. No-op batches: SAME array reference ────────────────────────

  it("update op for an id NOT in the result set preserves the items reference", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-noop-id", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeVersion = entry.version;

    // The id "p999" is not in our result set. applyOps must NOT
    // mutate anything and MUST return the same array reference so
    // downstream consumers don't spuriously re-render.
    client.emitQueryOps("h-noop-id", [
      {
        op: "update",
        id: "p999",
        patch: [{ op: "replace", path: "/title", value: "ghost" }],
      },
    ]);

    expect(entry.items).toBe(beforeArray);
    expect(entry.version).toBe(beforeVersion);

    release();
  });

  it("empty ops batch preserves the items reference", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-empty", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeVersion = entry.version;

    client.emitQueryOps("h-empty", []);

    expect(entry.items).toBe(beforeArray);
    expect(entry.version).toBe(beforeVersion);

    release();
  });

  // ── 3. Add / remove ops: NEW array reference, new membership ──────

  it("add op returns a NEW items array reference (membership change)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-add", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeP1 = entry.items[0];

    client.emitQueryOps("h-add", [
      {
        op: "add",
        id: "p2",
        data: { id: "p2", title: "second" },
      },
    ]);

    expect(entry.items).not.toBe(beforeArray);
    expect(entry.items).toHaveLength(2);
    // Existing item identity preserved.
    expect(entry.items.find((i: any) => i.id === "p1")).toBe(beforeP1);
    // New item present.
    const added = entry.items.find((i: any) => i.id === "p2");
    expect(added).toBeDefined();
    expect(added.title).toBe("second");

    release();
  });

  it("remove op returns a NEW items array reference (membership change)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-remove", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    const beforeArray = entry.items;
    const beforeP2 = entry.items[1];

    client.emitQueryOps("h-remove", [{ op: "remove", id: "p1" }]);

    expect(entry.items).not.toBe(beforeArray);
    expect(entry.items).toHaveLength(1);
    // Surviving item identity preserved.
    expect(entry.items[0]).toBe(beforeP2);
    expect(entry.items[0].id).toBe("p2");

    release();
  });

  // ── 4. Regression — the bug the slice() fix prevents ──────────────

  it("downstream useMemo-style dep arrays see a NEW items reference on update (regression: items.slice fix)", async () => {
    // Models the canonical bug: a consumer wrapping items in a
    // useMemo derives row objects. Pre-fix, the items reference
    // was identical after an update-only op so the useMemo
    // returned its cached value and the UI stayed stale even
    // though the underlying Model field mutated. This test pins
    // the contract by simulating exactly what useMemo's
    // dep-array compare does (Object.is on the items ref).
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-memo", [
      { id: "p1", title: "first" },
    ]);

    const memoizedDep = entry.items;
    // Simulate `useMemo(() => items.map(toRow), [items])` — the
    // cached value is keyed on the items reference at memo time.
    const cachedRows = memoizedDep.map((i: any) => ({
      id: i.id,
      label: i.title,
    }));

    client.emitQueryOps("h-memo", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "after" }],
      },
    ]);

    // The dep-array compare must see a new reference. Pre-fix
    // this would be `true` and React would return the stale
    // cachedRows. Post-fix it's `false` and the consumer
    // recomputes against the mutated model state.
    expect(Object.is(entry.items, memoizedDep)).toBe(false);

    // The freshly recomputed derived state reflects the
    // mutation. (Recomputing here mirrors what useMemo's body
    // would do when the dep array changed.)
    const freshRows = entry.items.map((i: any) => ({
      id: i.id,
      label: i.title,
    }));
    expect(freshRows[0].label).toBe("after");
    expect(cachedRows[0].label).toBe("first"); // sanity: pre-update snapshot

    release();
  });
});
