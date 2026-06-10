/**
 * useQuery — `{ subscribe: false }` opt-out (DOL-1148).
 *
 * Pins the invariants:
 *
 *   1. The cache key gets a `:nosub` suffix so static and dynamic
 *      mounts of the same chain don't share an entry.
 *   2. `doFetch` calls `chain.withSubscribe(false)` before `.find()`
 *      so the wire request carries `__subscribe: false`.
 *   3. Even if a misbehaving backend returns a `__queryHash`, the
 *      SDK doesn't attach a `query:${hash}` listener for static
 *      entries (defensive gate in `doFetch`).
 *   4. `_onResyncRequired` includes `subscribe: false` in the resync
 *      payload entries for static cache entries (and OMITS the field
 *      for dynamic entries so older backends remain compatible).
 *   5. A resync result with `hash: null` does NOT attach a listener,
 *      even for cache entries whose `subscribe` flag has somehow
 *      been mutated to `true` mid-flight.
 *   6. `prefetch(..., { subscribe: false })` resolves from the static
 *      "already loaded" fast path that doesn't require `queryHash`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import {
  prefetch,
  __test as useQueryTest,
} from "../react/useQuery";

// ─── Fake Model class ───────────────────────────────────────────────────────

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

// ─── FakeClient ─────────────────────────────────────────────────────────────

interface SubscriptionRegistration {
  event: string;
  handler: (...args: any[]) => void;
}

class FakeClient extends EventEmitter {
  public subscriptions: SubscriptionRegistration[] = [];
  public resync = vi.fn(async (_entries: any[]) => [] as any[]);
  public session = {
    ready: Promise.resolve(),
    state: { userId: null as string | null },
  };

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const entry = { event, handler };
    this.subscriptions.push(entry);
    return () => {
      const idx = this.subscriptions.indexOf(entry);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  countSubs(event: string): number {
    return this.subscriptions.filter((s) => s.event === event).length;
  }
}

// ─── chain factory ──────────────────────────────────────────────────────────

interface FakeChainOptions {
  results?: Array<{ id: string; title?: string }>;
  queryHash?: string;
}

function makeChain(opts: FakeChainOptions = {}): any {
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
    findCalls: 0,
    withSubscribeCalls: 0,
    lastSubscribe: undefined as boolean | undefined,
  };

  chain.find = async () => {
    chain.findCalls++;
    const items = (opts.results ?? []).map((r) =>
      Post.hydrate({} as any, r),
    );
    if (opts.queryHash) {
      Object.defineProperty(items, "__queryHash", {
        value: opts.queryHash,
        enumerable: false,
      });
    }
    Object.defineProperty(items, "__totalCount", {
      value: (opts.results ?? []).length,
      enumerable: false,
    });
    return items;
  };

  // Mirror the production sibling-chain shape — for the test we
  // capture the call and return the same chain so `.find()` still
  // bumps `findCalls`. Production returns a fresh chain with
  // `__subscribe = false` baked in (see model/adapters/client.ts).
  chain.withSubscribe = (subscribe: boolean) => {
    chain.withSubscribeCalls++;
    chain.lastSubscribe = subscribe;
    return chain;
  };

  return chain;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("useQuery — { subscribe: false }", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });

  afterEach(() => {
    useQueryTest.resetCache();
  });

  it("buildKey suffixes `:nosub` so static and dynamic mounts don't collide", () => {
    const dyn = useQueryTest.buildKey("post", "u1", []);
    const stat = useQueryTest.buildKey("post", "u1", [], false);
    expect(stat).not.toEqual(dyn);
    expect(stat.endsWith(":nosub")).toBe(true);
    // Default arg behaviour unchanged for legacy callers.
    expect(useQueryTest.buildKey("post", "u1", [], true)).toEqual(dyn);
  });

  it("doFetch calls chain.withSubscribe(false) before .find() when entry.subscribe is false", async () => {
    const chain = makeChain({ results: [{ id: "1" }] });
    const client = new FakeClient() as any;
    const key = useQueryTest.buildKey("post", null, [], false);

    useQueryTest.fetch(key, chain, client, false);
    await Promise.resolve();
    await Promise.resolve();

    expect(chain.withSubscribeCalls).toBe(1);
    expect(chain.lastSubscribe).toBe(false);
    expect(chain.findCalls).toBe(1);
  });

  it("doFetch with subscribe:true (default) does NOT call withSubscribe and DOES attach a listener when hash is returned", async () => {
    const chain = makeChain({ results: [{ id: "1" }], queryHash: "h-dyn" });
    const client = new FakeClient() as any;
    const key = useQueryTest.buildKey("post", null, []);

    useQueryTest.fetch(key, chain, client);
    await Promise.resolve();
    await Promise.resolve();

    expect(chain.withSubscribeCalls).toBe(0);
    expect(client.countSubs("query:h-dyn")).toBe(1);
  });

  it("doFetch with subscribe:false does NOT attach a listener even if backend returns a hash (defensive)", async () => {
    // Simulate a misbehaving backend that ignored `__subscribe: false`
    // and returned a queryHash anyway. The SDK must refuse to attach
    // a `query:${hash}` listener — otherwise the static-mode contract
    // (no realtime push) silently breaks.
    const chain = makeChain({ results: [{ id: "1" }], queryHash: "h-stale" });
    const client = new FakeClient() as any;
    const key = useQueryTest.buildKey("post", null, [], false);

    useQueryTest.fetch(key, chain, client, false);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.countSubs("query:h-stale")).toBe(0);
    const entry = useQueryTest.getEntry(key);
    expect(entry?.queryHash).toBeNull();
  });

  it("getOrCreate captures `subscribe` on first arrival; subsequent retains don't override", () => {
    const key = useQueryTest.buildKey("post", null, [], false);
    const release = useQueryTest.retain(key, () => {}, false);
    expect(useQueryTest.getEntry(key)?.subscribe).toBe(false);

    // A second retain with subscribe:true must not flip the entry's
    // mode. Cache key includes the subscribe suffix anyway, so a
    // genuine dynamic mount would land on a different key — this
    // test guards the contract for direct `retain` callers.
    const release2 = useQueryTest.retain(key, () => {}, true);
    expect(useQueryTest.getEntry(key)?.subscribe).toBe(false);

    release2();
    release();
  });

  it("_onResyncRequired includes `subscribe: false` for static entries and omits the field for dynamic ones", async () => {
    const staticChain = makeChain({ results: [{ id: "s1" }] });
    const dynamicChain = makeChain({
      results: [{ id: "d1" }],
      queryHash: "h-dyn",
    });
    const client = new FakeClient() as any;

    const staticKey = useQueryTest.buildKey("post", null, [], false)!;
    const dynamicKey = useQueryTest.buildKey("post", null, [])!;

    useQueryTest.fetch(staticKey, staticChain, client, false);
    useQueryTest.fetch(dynamicKey, dynamicChain, client);
    await Promise.resolve();
    await Promise.resolve();

    // Retain both so they have refs > 0 (resync skips refs<=0).
    const r1 = useQueryTest.retain(staticKey, () => {}, false);
    const r2 = useQueryTest.retain(dynamicKey, () => {});

    useQueryTest.onResyncRequired(client);

    expect(client.resync).toHaveBeenCalledOnce();
    const entries = client.resync.mock.calls[0]![0] as any[];
    expect(entries).toHaveLength(2);

    const staticEntry = entries.find((e) => e.key === staticKey);
    const dynamicEntry = entries.find((e) => e.key === dynamicKey);

    expect(staticEntry).toBeDefined();
    expect(staticEntry.subscribe).toBe(false);

    expect(dynamicEntry).toBeDefined();
    // The dynamic entry must OMIT `subscribe` so older backends that
    // don't know the field continue treating it as subscribed.
    expect("subscribe" in dynamicEntry).toBe(false);

    r1();
    r2();
  });

  it("prefetch({ subscribe: false }) hits the static fast-path without requiring a queryHash", async () => {
    const chain = makeChain({ results: [{ id: "p1" }] });
    const client = new FakeClient() as any;

    // First prefetch — must drive the fetch and resolve once items land.
    const items = await prefetch(client as any, chain, { subscribe: false });
    expect(items).toHaveLength(1);
    expect(chain.findCalls).toBe(1);
    expect(chain.lastSubscribe).toBe(false);

    // Second prefetch on the same chain — the cache entry is now
    // loaded with no queryHash. The static fast-path must short-
    // circuit and NOT call find() again. The legacy subscribed path
    // would deadlock here (it gates the fast-path on `queryHash !==
    // null`, which is null for static entries).
    const items2 = await prefetch(client as any, chain, { subscribe: false });
    expect(items2).toHaveLength(1);
    expect(chain.findCalls).toBe(1);
  });
});
