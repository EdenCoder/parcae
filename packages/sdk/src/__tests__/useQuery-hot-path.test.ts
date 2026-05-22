/**
 * useQuery — hot-path optimisations (DOL-1041).
 *
 * Three perf invariants pinned here:
 *
 *   1. `entry.hash` is O(1) regardless of items count. The previous
 *      implementation concatenated every item id into the hash string,
 *      making `buildHash` O(N) and triggering an allocation proportional
 *      to the result-set size on every subscription op.
 *
 *   2. `entry.mergedItems` (the cached server + optimistic merge) is
 *      reference-stable across reads when neither side changed. The
 *      previous implementation recomputed the merge on every render
 *      via an O(N×M) `.reduce` + `acc.some` scan.
 *
 *   3. `applyOps` update path no longer routes through
 *      `JSON.parse(JSON.stringify(...))` on the existing `__data`. We
 *      can't observe the implementation directly but we cover
 *      correctness: per-item field updates still land + per-item
 *      identity stays stable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { __test as useQueryTest } from "../react/useQuery";

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

class FakeClient extends EventEmitter {
  public subscriptions: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }> = [];

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

describe("useQuery hot-path optimisations (DOL-1041)", () => {
  beforeEach(() => useQueryTest.resetCache());
  afterEach(() => useQueryTest.resetCache());

  // ── 1. Hash is O(1) regardless of items count ─────────────────────

  it("entry.hash length stays bounded as items count grows", async () => {
    // Two cache entries: one with 5 items, one with 500. The hash
    // must not embed per-item ids — its length should be the same
    // within a few characters regardless of result size.
    const client = new FakeClient();
    const small = await primeCache(
      client,
      "h-small",
      Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, title: `t${i}` })),
    );
    const big = await primeCache(
      client,
      "h-big",
      Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, title: `t${i}` })),
    );

    // The old O(N) hash for 500 items was ~3.5KB of string per
    // re-eval. The new hash should be < 50 chars regardless.
    expect(small.entry.hash.length).toBeLessThan(50);
    expect(big.entry.hash.length).toBeLessThan(50);
    // And the ratio should be near 1 (the difference is just the
    // changing `i500` vs `i5` digit count).
    const ratio = big.entry.hash.length / small.entry.hash.length;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);

    small.release();
    big.release();
  });

  it("hash still changes when a subscription op mutates an item (so consumers re-render)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-change", [
      { id: "p1", title: "first" },
    ]);
    const beforeHash = entry.hash;

    client.emitQueryOps("h-change", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "updated" }],
      },
    ]);

    expect(entry.hash).not.toBe(beforeHash);
    release();
  });

  // ── 2. Optimistic merge is cached + reference-stable ──────────────

  it("getMergedItems returns the server items reference directly when optimistic is empty", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-empty-opt", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    // With no optimistic items, the merge MUST be the same reference
    // as `entry.items` (no allocation for the wrapping array).
    const merged1 = useQueryTest.getMergedItems(entry);
    const merged2 = useQueryTest.getMergedItems(entry);
    expect(merged1).toBe(entry.items);
    expect(merged2).toBe(entry.items);
    expect(merged1).toBe(merged2);

    release();
  });

  it("getMergedItems caches the merged array across reads when nothing changed", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-cache", [
      { id: "p1", title: "first" },
    ]);

    // Push an optimistic item directly into the cache entry so we
    // exercise the merge path without going through the React hook.
    const optimistic = Post.hydrate({} as any, { id: "opt-1", title: "draft" });
    entry.optimistic.push(optimistic);
    entry.version++;

    const merged1 = useQueryTest.getMergedItems(entry);
    const merged2 = useQueryTest.getMergedItems(entry);

    // Two reads with no intervening change → identical reference.
    expect(merged1).toBe(merged2);
    // Merged shape is correct: server item first, then optimistic.
    expect(merged1).toHaveLength(2);
    expect(merged1[0]!.id).toBe("p1");
    expect(merged1[1]!.id).toBe("opt-1");

    release();
  });

  it("getMergedItems invalidates the cache when optimistic changes", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-invalidate", [
      { id: "p1", title: "first" },
    ]);

    const optA = Post.hydrate({} as any, { id: "opt-a", title: "A" });
    entry.optimistic.push(optA);
    entry.version++;
    const beforeMerge = useQueryTest.getMergedItems(entry);

    const optB = Post.hydrate({} as any, { id: "opt-b", title: "B" });
    entry.optimistic.push(optB);
    entry.version++;
    const afterMerge = useQueryTest.getMergedItems(entry);

    expect(afterMerge).not.toBe(beforeMerge);
    expect(afterMerge).toHaveLength(3);
    expect(afterMerge[0]!.id).toBe("p1");
    expect(afterMerge[1]!.id).toBe("opt-a");
    expect(afterMerge[2]!.id).toBe("opt-b");

    release();
  });

  it("getMergedItems dedups optimistic items that share an id with a server item (server wins)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-dedup-id", [
      { id: "p1", title: "server" },
    ]);

    // Optimistic item with same id (e.g. user pre-rendered a row
    // before the server confirmed). Server should win — merged
    // result must only have one row with id=p1, the server one.
    const optDupe = Post.hydrate({} as any, { id: "p1", title: "optimistic" });
    entry.optimistic.push(optDupe);
    entry.version++;
    const merged = useQueryTest.getMergedItems(entry);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("server");

    release();
  });

  it("getMergedItems dedups optimistic items by tmp (server item created from optimistic)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-dedup-tmp", [
      { id: "p1", title: "server" },
    ]);
    // Server item also has a `tmp` claim back to the optimistic.
    (entry.items[0] as any).tmp = "tmp-x";

    const optTmp = Post.hydrate({} as any, { id: "opt-x", title: "opt" });
    (optTmp as any).tmp = "tmp-x";
    entry.optimistic.push(optTmp);
    entry.version++;
    const merged = useQueryTest.getMergedItems(entry);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("p1");

    release();
  });

  // ── 3. Update path correctness preserved (was JSON round-trip) ────

  it("applyOps update path still updates fields and keeps per-item identity", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-update-correct", [
      { id: "p1", title: "first", body: "B1" },
      { id: "p2", title: "second", body: "B2" },
    ]);
    const beforeP1 = entry.items[0];
    const beforeP2 = entry.items[1];

    client.emitQueryOps("h-update-correct", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "updated" }],
      },
    ]);

    // Same per-item references (in-place SYM_SERVER_MERGE).
    expect(entry.items[0]).toBe(beforeP1);
    expect(entry.items[1]).toBe(beforeP2);
    // Update landed on the right field; sibling field untouched.
    expect(entry.items[0]!.title).toBe("updated");
    expect(entry.items[0]!.body).toBe("B1");
    expect(entry.items[1]!.title).toBe("second");

    release();
  });
});
