/**
 * prefetch() — auth-safe cache priming for useQuery.
 *
 * Contract pinned here:
 *
 *   1. Returns items from cache when the entry is already loaded.
 *   2. Fires a fresh fetch when the entry doesn't exist.
 *   3. Multiple parallel prefetches share one underlying wire request.
 *   4. **Auth safety**: waits for `transport.auth.ready` before
 *      building the cache key. Without this guard, an early prefetch
 *      would key authenticated data under `:anon:`, leaking it to
 *      subsequent anonymous reads on the same chain.
 *   5. `waitForAuth: false` opts out for legitimately-anonymous
 *      prefetches.
 *
 * Tests stub `client.transport.auth` directly so we can control the
 * resolve timing without booting a real socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { prefetch, __test as useQueryTest } from "../react/useQuery";
import type { ParcaeClient } from "../client";

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

interface StubGate {
  ready: Promise<void>;
  resolve: () => void;
  state: { userId: string | null };
}

function makeGate(initialUserId: string | null): StubGate {
  let resolveFn: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveFn = r;
  });
  return {
    ready,
    resolve: () => resolveFn(),
    state: { userId: initialUserId },
  };
}

interface FakeClient extends EventEmitter {
  transport: any;
  subscriptions: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  emitQueryOps(hash: string, ops: unknown[]): void;
}

function makeFakeClient(gate: StubGate): FakeClient {
  const subs: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  const ee = new EventEmitter() as any as FakeClient;
  ee.transport = { auth: gate };
  ee.subscriptions = subs;
  ee.subscribe = (event: string, handler: (...args: any[]) => void) => {
    const entry = { event, handler };
    subs.push(entry);
    return () => {
      const i = subs.indexOf(entry);
      if (i >= 0) subs.splice(i, 1);
    };
  };
  ee.emitQueryOps = (hash: string, ops: unknown[]) => {
    for (const s of subs) {
      if (s.event === `query:${hash}`) s.handler(ops);
    }
  };
  return ee;
}

function makeChain(opts: {
  results: Array<{ id: string; title?: string }>;
  queryHash: string;
  findSpy?: () => void;
}) {
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
  };
  chain.find = async () => {
    opts.findSpy?.();
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

describe("prefetch", () => {
  beforeEach(() => useQueryTest.resetCache());
  afterEach(() => useQueryTest.resetCache());

  it("fires the chain.find() exactly once and returns the items", async () => {
    const gate = makeGate("u1");
    gate.resolve(); // already authenticated
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1", title: "first" }],
      queryHash: "h-pre-1",
      findSpy,
    });

    const items = await prefetch(client as unknown as ParcaeClient, chain);

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect((items[0] as any).id).toBe("p1");
    expect((items[0] as any).title).toBe("first");
  });

  it("returns the existing cache entry without re-fetching when called twice", async () => {
    const gate = makeGate("u1");
    gate.resolve();
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-pre-2",
      findSpy,
    });

    const first = await prefetch(client as unknown as ParcaeClient, chain);
    const second = await prefetch(client as unknown as ParcaeClient, chain);

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("coalesces parallel prefetches into a single wire request", async () => {
    const gate = makeGate("u1");
    gate.resolve();
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }, { id: "p2" }],
      queryHash: "h-pre-3",
      findSpy,
    });

    const [a, b, c] = await Promise.all([
      prefetch(client as unknown as ParcaeClient, chain),
      prefetch(client as unknown as ParcaeClient, chain),
      prefetch(client as unknown as ParcaeClient, chain),
    ]);

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(2);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("waits for auth.ready BEFORE building the cache key (auth-safety)", async () => {
    // Gate is pending — `state.userId` is null right now.
    const gate = makeGate(null);
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-auth-safe",
      findSpy,
    });

    // Kick off the prefetch while still pending.
    const pending = prefetch(client as unknown as ParcaeClient, chain);

    // No fetch happened yet — we're parked on auth.ready.
    await new Promise((r) => setImmediate(r));
    expect(findSpy).not.toHaveBeenCalled();

    // The cache must NOT contain an `:anon:` key for this chain.
    // Without the guard, the key would have been built with
    // userId=null → ":anon:" and the entry would already exist.
    const anonKey = useQueryTest.buildKey("post", null, chain.__steps);
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();

    // Resolve auth with a real user id, THEN release the prefetch.
    gate.state.userId = "u-authsafe";
    gate.resolve();

    await pending;

    // The fetch fired, and the entry is keyed under the resolved
    // user — never under `:anon:`.
    expect(findSpy).toHaveBeenCalledTimes(1);
    const userKey = useQueryTest.buildKey(
      "post",
      "u-authsafe",
      chain.__steps,
    );
    expect(useQueryTest.getEntry(userKey)).toBeDefined();
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();
  });

  it("skips the auth gate when waitForAuth: false (opt-in anonymous prefetch)", async () => {
    const gate = makeGate(null); // pending, no userId
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p-pub" }],
      queryHash: "h-anon",
      findSpy,
    });

    // Don't resolve the gate — `waitForAuth: false` shouldn't care.
    const items = await prefetch(client as unknown as ParcaeClient, chain, {
      waitForAuth: false,
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    // The entry IS keyed under `:anon:` here — that's expected
    // because the caller opted in to anonymous prefetch.
    const anonKey = useQueryTest.buildKey("post", null, chain.__steps);
    expect(useQueryTest.getEntry(anonKey)).toBeDefined();
  });

  it("primes the cache so a subsequent useQuery sees items without re-fetching", async () => {
    const gate = makeGate("u1");
    gate.resolve();
    const client = makeFakeClient(gate);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }, { id: "p2" }],
      queryHash: "h-prime",
      findSpy,
    });

    await prefetch(client as unknown as ParcaeClient, chain);
    expect(findSpy).toHaveBeenCalledTimes(1);

    // A subsequent consumer (simulated) looks up the cache by the
    // same key and finds the populated entry.
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const entry = useQueryTest.getEntry(key);
    expect(entry).toBeDefined();
    expect(entry!.items).toHaveLength(2);
    expect(entry!.loading).toBe(false);
    expect(entry!.queryHash).toBe("h-prime");

    // The subscription is hooked up so realtime ops still land.
    client.emitQueryOps("h-prime", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "live" }],
      },
    ]);
    expect((entry!.items[0] as any).title).toBe("live");
  });

  it("throws if the chain has no __modelType", async () => {
    const gate = makeGate("u1");
    gate.resolve();
    const client = makeFakeClient(gate);
    const badChain = { __steps: [] } as any;
    await expect(
      prefetch(client as unknown as ParcaeClient, badChain),
    ).rejects.toThrow(/__modelType/);
  });
});
