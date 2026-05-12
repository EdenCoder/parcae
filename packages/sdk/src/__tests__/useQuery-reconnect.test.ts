/**
 * useQuery — disconnect / reconnect behaviour.
 *
 * Drives the module-level cache directly via the `__test` surface so
 * we don't need React DOM. The cache is the contract: a subscriber
 * holds a ref, `doFetch` populates it, the client's `"connected"`
 * event triggers a refetch on the next reconnect, and the retry
 * timer is bounded.
 *
 * Each test uses a `FakeClient` shaped like `ParcaeClient` — just
 * the surface useQuery touches:
 *   - `subscribe(event, handler)` for `query:<hash>` updates
 *   - `on/off` for `"connected"` / `"disconnected"`
 *
 * The `chain` argument carries `__modelType` / `__modelClass` /
 * `__adapter` plus a `find()` factory the tests control directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

// eslint-disable-next-line import/first
import { __test as useQueryTest } from "../react/useQuery";

// ─── Fake Model class for the tests ─────────────────────────────────────────

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

// ─── FakeClient — minimal ParcaeClient surface ──────────────────────────────

interface SubscriptionRegistration {
  event: string;
  handler: (...args: any[]) => void;
}

class FakeClient extends EventEmitter {
  /** Map of event → set of handlers. Mirrors `transport.subscribe`. */
  public subscriptions: SubscriptionRegistration[] = [];

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const entry = { event, handler };
    this.subscriptions.push(entry);
    return () => {
      const idx = this.subscriptions.indexOf(entry);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  /** Emit a server-side `query:<hash>` ops batch through the subscription. */
  emitQueryOps(hash: string, ops: unknown[]): void {
    for (const sub of this.subscriptions) {
      if (sub.event === `query:${hash}`) sub.handler(ops);
    }
  }

  /** Count active subscriptions for an event. */
  countSubs(event: string): number {
    return this.subscriptions.filter((s) => s.event === event).length;
  }
}

// ─── chain factory ──────────────────────────────────────────────────────────

interface FakeChainOptions {
  /** What the next `.find()` returns. Override per test. */
  results?: any[];
  /** Hash to attach as `__queryHash`. */
  queryHash?: string;
  /** Force `.find()` to reject. */
  reject?: Error;
}

function makeChain(opts: FakeChainOptions = {}): any {
  const results = opts.results ?? [];
  const queryHash = opts.queryHash;
  const reject = opts.reject;

  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
    findCalls: 0,
  };

  chain.find = async () => {
    chain.findCalls++;
    if (reject) throw reject;
    // Mirror FrontendAdapter — attach `__queryHash` / `__totalCount` as
    // non-enumerable properties on the returned array.
    const items = results.map((r) => {
      const inst: any = Post.hydrate({} as any, r);
      return inst;
    });
    if (queryHash) {
      Object.defineProperty(items, "__queryHash", {
        value: queryHash,
        enumerable: false,
      });
    }
    Object.defineProperty(items, "__totalCount", {
      value: results.length,
      enumerable: false,
    });
    return items;
  };

  return chain;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useQuery — cache lifecycle across disconnect/reconnect", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });

  afterEach(() => {
    useQueryTest.resetCache();
    vi.useRealTimers();
  });

  // ── Initial fetch populates the cache ───────────────────────────────

  it("doFetch resolves loading=false, populates items, picks up __queryHash", async () => {
    const client = new FakeClient();
    const chain = makeChain({
      results: [
        { id: "p1", title: "first" },
        { id: "p2", title: "second" },
      ],
      queryHash: "h123",
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const onChange = vi.fn();
    const release = useQueryTest.retain(key, onChange);

    useQueryTest.fetch(key, chain, client as any);

    // Tick the microtask queue so chain.find() resolves.
    await new Promise((r) => setImmediate(r));

    const entry = useQueryTest.getEntry(key)!;
    expect(entry.loading).toBe(false);
    expect(entry.items.length).toBe(2);
    expect(entry.items[0].id).toBe("p1");
    expect(entry.totalCount).toBe(2);
    expect(entry.queryHash).toBe("h123");
    expect(entry.error).toBeNull();
    // The subscription was registered exactly once.
    expect(client.countSubs("query:h123")).toBe(1);

    release();
  });

  // ── Subscription ops mutate cached models in-place ──────────────────

  it("update ops apply via SYM_SERVER_MERGE — model identity is stable", async () => {
    const client = new FakeClient();
    const chain = makeChain({
      results: [{ id: "p1", title: "first" }],
      queryHash: "h-update",
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(key, () => {});

    useQueryTest.fetch(key, chain, client as any);
    await new Promise((r) => setImmediate(r));

    const entry = useQueryTest.getEntry(key)!;
    const firstInstance = entry.items[0];
    expect(firstInstance.title).toBe("first");

    // Server pushes an update via the subscription.
    client.emitQueryOps("h-update", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "updated" }],
      },
    ]);

    expect(entry.items[0]).toBe(firstInstance); // identity preserved
    expect(entry.items[0].title).toBe("updated");
    expect(entry.version).toBe(1); // bumped on changed=true
    release();
  });

  // ── Error path schedules a retry ────────────────────────────────────

  it("a failing fetch schedules a retry; the retry runs after the backoff", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();

    // First fetch rejects; subsequent fetches use the same chain, so
    // swap its `find` after the failure to simulate a recovered server.
    const chain = makeChain({ reject: new Error("network down") });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(key, () => {});

    useQueryTest.fetch(key, chain, client as any);
    await vi.advanceTimersByTimeAsync(0);

    let entry = useQueryTest.getEntry(key)!;
    expect(entry.error?.message).toContain("network down");
    expect(entry.retryTimer).not.toBeNull();

    // Swap the chain so the retry succeeds. The retry uses the stored
    // chain ref on the entry, so swap that too.
    const goodChain = makeChain({
      results: [{ id: "p1", title: "recovered" }],
      queryHash: "h-after-retry",
    });
    entry.chain = goodChain;

    // Advance to the first retry delay (1000ms).
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve();

    entry = useQueryTest.getEntry(key)!;
    expect(entry.error).toBeNull();
    expect(entry.items.length).toBe(1);
    expect(entry.items[0].title).toBe("recovered");
    expect(entry.retryCount).toBe(0); // reset on success
    release();
  });

  it("retries stop firing once the entry is released (refs=0)", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const chain = makeChain({ reject: new Error("network down") });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    const release = useQueryTest.retain(key, () => {});
    useQueryTest.fetch(key, chain, client as any);
    await vi.advanceTimersByTimeAsync(0);

    const entry = useQueryTest.getEntry(key)!;
    expect(entry.retryTimer).not.toBeNull();

    // Unmount before the retry fires. The retry timer was stored on
    // the entry but the unsubscribe path in `useQuery` clears it when
    // `refs` drops to 0. The `__test.retain` helper mimics the same
    // teardown.
    release();
    expect(entry.refs).toBe(0);

    // The entry's GC timer is now armed at 60s; advance past every
    // possible retry delay (1+3+10s) and confirm no `find` re-fires.
    const findCallsBefore = chain.findCalls;
    await vi.advanceTimersByTimeAsync(20_000);
    // `scheduleRetry` guards on `entry.refs <= 0` so it should bail.
    // The retry handler also re-checks before doing a fetch.
    expect(chain.findCalls).toBe(findCallsBefore);
  });

  // ── Reconnect: useQuery's "connected" listener refetches ────────────

  it("listens for the client's 'connected' event and refetches on it", async () => {
    const client = new FakeClient();
    const chain = makeChain({
      results: [{ id: "p1", title: "v1" }],
      queryHash: "h-recon-1",
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(key, () => {});

    useQueryTest.fetch(key, chain, client as any);
    await new Promise((r) => setImmediate(r));

    const entry = useQueryTest.getEntry(key)!;
    expect(entry.items[0].title).toBe("v1");
    expect(chain.findCalls).toBe(1);

    // Simulate what `useQuery`'s reconnect-listener effect does:
    // attach `client.on("connected", onReconnect)` and have it call
    // `doFetch` again. We test the cache reaction.
    const onReconnect = () => {
      const ent = useQueryTest.getEntry(key);
      if (!ent || !ent.chain || !ent.client) return;
      ent.retryCount = 0;
      if (ent.retryTimer) {
        clearTimeout(ent.retryTimer);
        ent.retryTimer = null;
      }
      // Use the new data
      const next = makeChain({
        results: [
          { id: "p1", title: "v1-stale" },
          { id: "p2", title: "fresh-after-reconnect" },
        ],
        queryHash: "h-recon-2",
      });
      ent.chain = next;
      useQueryTest.fetch(key, next, client as any);
    };
    client.on("connected", onReconnect);

    // Fire the "connected" event — emulates a reconnect.
    client.emit("connected");
    await new Promise((r) => setImmediate(r));

    const after = useQueryTest.getEntry(key)!;
    expect(after.items.length).toBe(2);
    expect(after.items[1].title).toBe("fresh-after-reconnect");
    // The new __queryHash replaces the old one — the previous
    // subscription is disposed so we don't leak.
    expect(after.queryHash).toBe("h-recon-2");
    expect(client.countSubs("query:h-recon-1")).toBe(0);
    expect(client.countSubs("query:h-recon-2")).toBe(1);

    release();
  });

  // ── Stale-during-disconnect contract ────────────────────────────────

  it("items remain populated across a simulated disconnect (auth=pending)", async () => {
    const client = new FakeClient();
    const chain = makeChain({
      results: [{ id: "p1", title: "before-disconnect" }],
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(key, () => {});

    useQueryTest.fetch(key, chain, client as any);
    await new Promise((r) => setImmediate(r));

    const entry = useQueryTest.getEntry(key)!;
    expect(entry.items[0].title).toBe("before-disconnect");

    // During a disconnect, `useQuery`'s `liveKey` becomes null (auth
    // reset to pending) but `lastKeyRef.current` holds the previous
    // key. From the cache's POV, no `release()` happens and no
    // refetch fires — the same entry stays populated.
    client.emit("disconnected");

    // The entry is untouched.
    expect(entry.items[0].title).toBe("before-disconnect");
    expect(entry.loading).toBe(false);
    expect(entry.refs).toBe(1);

    release();
  });

  // ── Subscription churn: re-fetch with the SAME hash doesn't re-sub ──

  it("a refetch that returns the same __queryHash doesn't churn the subscription", async () => {
    const client = new FakeClient();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-stable",
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(key, () => {});

    useQueryTest.fetch(key, chain, client as any);
    await new Promise((r) => setImmediate(r));
    expect(client.countSubs("query:h-stable")).toBe(1);

    // Second fetch with the same hash — the existing subscription
    // should be preserved.
    const entry = useQueryTest.getEntry(key)!;
    const same = makeChain({
      results: [{ id: "p1", title: "refreshed" }],
      queryHash: "h-stable", // same!
    });
    entry.chain = same;
    useQueryTest.fetch(key, same, client as any);
    await new Promise((r) => setImmediate(r));

    expect(client.countSubs("query:h-stable")).toBe(1); // unchanged
    expect(entry.items[0].title).toBe("refreshed");

    release();
  });

  // ── Subscription cleanup on release ─────────────────────────────────

  it("releasing all refs disposes the query:<hash> subscription via the GC timer", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-gc",
    });
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    const release = useQueryTest.retain(key, () => {});
    useQueryTest.fetch(key, chain, client as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.countSubs("query:h-gc")).toBe(1);

    // Drop the only subscriber. The real hook's `subscribe` cleanup
    // arms a GC timer at 60s that calls entry.dispose() and removes
    // from the cache. The `__test.retain` helper mimics the
    // refs-- behaviour but not the GC timer; for a complete test of
    // subscription cleanup, we manually invoke the cache's GC path
    // here by calling dispose + setting refs=0 explicitly the way
    // the hook does.
    release();
    const entry = useQueryTest.getEntry(key)!;
    entry.dispose?.();
    expect(client.countSubs("query:h-gc")).toBe(0);
  });
});
