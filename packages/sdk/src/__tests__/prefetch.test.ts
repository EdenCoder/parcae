/**
 * prefetch() — session-safe cache priming for useQuery.
 *
 * Contract pinned here:
 *
 *   1. Returns items from cache when the entry is already loaded.
 *   2. Fires a fresh fetch when the entry doesn't exist.
 *   3. Multiple parallel prefetches share one underlying wire request.
 *   4. **Session safety**: waits for `client.session.ready` before
 *      building the cache key. Without this guard, an early prefetch
 *      would key authenticated data under `:anon:`, leaking it to
 *      subsequent anonymous reads on the same chain.
 *   5. `waitForSession: false` opts out for legitimately-anonymous
 *      prefetches.
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

interface StubSession {
  ready: Promise<void>;
  resolve: () => void;
  state: { userId: string | null };
}

function makeSession(initialUserId: string | null): StubSession {
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
  session: StubSession;
  subscriptions: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  emitQueryOps(hash: string, ops: unknown[]): void;
}

function makeFakeClient(session: StubSession): FakeClient {
  const subs: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  const ee = new EventEmitter() as any as FakeClient;
  ee.session = session;
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
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
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
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
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
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
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

  it("waits for session.ready BEFORE building the cache key (session-safety)", async () => {
    const session = makeSession(null);
    const client = makeFakeClient(session);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-auth-safe",
      findSpy,
    });

    const pending = prefetch(client as unknown as ParcaeClient, chain);

    await new Promise((r) => setImmediate(r));
    expect(findSpy).not.toHaveBeenCalled();

    const anonKey = useQueryTest.buildKey("post", null, chain.__steps);
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();

    session.state.userId = "u-authsafe";
    session.resolve();

    await pending;

    expect(findSpy).toHaveBeenCalledTimes(1);
    const userKey = useQueryTest.buildKey(
      "post",
      "u-authsafe",
      chain.__steps,
    );
    expect(useQueryTest.getEntry(userKey)).toBeDefined();
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();
  });

  it("skips the session gate when waitForSession: false", async () => {
    const session = makeSession(null);
    const client = makeFakeClient(session);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p-pub" }],
      queryHash: "h-anon",
      findSpy,
    });

    const items = await prefetch(client as unknown as ParcaeClient, chain, {
      waitForSession: false,
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    const anonKey = useQueryTest.buildKey("post", null, chain.__steps);
    expect(useQueryTest.getEntry(anonKey)).toBeDefined();
  });

  it("primes the cache so a subsequent useQuery sees items without re-fetching", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }, { id: "p2" }],
      queryHash: "h-prime",
      findSpy,
    });

    await prefetch(client as unknown as ParcaeClient, chain);
    expect(findSpy).toHaveBeenCalledTimes(1);

    const key = useQueryTest.buildKey("post", "u1", chain.__steps);
    const entry = useQueryTest.getEntry(key);
    expect(entry).toBeDefined();
    expect(entry!.items).toHaveLength(2);
    expect(entry!.loading).toBe(false);
    expect(entry!.queryHash).toBe("h-prime");

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
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const badChain = { __steps: [] } as any;
    await expect(
      prefetch(client as unknown as ParcaeClient, badChain),
    ).rejects.toThrow(/__modelType/);
  });
});

describe("concurrent useQuery mounts on the same key", () => {
  beforeEach(() => useQueryTest.resetCache());
  afterEach(() => useQueryTest.resetCache());

  it("a second mount on the same key while the first fetch is in flight does NOT re-fire doFetch", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const findSpy = vi.fn();

    const buildChain = () =>
      makeChain({
        results: [{ id: "p1", title: "first" }],
        queryHash: "h-concurrent",
        findSpy,
      });

    const key = useQueryTest.buildKey("post", "u1", buildChain().__steps);

    const release1 = useQueryTest.retain(key, () => {});
    useQueryTest.fetch(key, buildChain(), client as unknown as ParcaeClient);

    const second = prefetch(client as unknown as ParcaeClient, buildChain());

    await new Promise((r) => setImmediate(r));
    const items = await second;

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect((items[0] as any).id).toBe("p1");
    release1();
  });
});

describe("_purgeCacheForUser (session-transition cache eviction)", () => {
  beforeEach(() => useQueryTest.resetCache());
  afterEach(() => useQueryTest.resetCache());

  it("drops only entries whose key includes the prior userId", async () => {
    const chainA = makeChain({
      results: [{ id: "p-a" }],
      queryHash: "h-a",
    });
    const chainB = makeChain({
      results: [{ id: "p-b" }],
      queryHash: "h-b",
    });

    const sessionA = makeSession("userA");
    sessionA.resolve();
    await prefetch(makeFakeClient(sessionA) as unknown as ParcaeClient, chainA);

    const sessionB = makeSession("userB");
    sessionB.resolve();
    await prefetch(makeFakeClient(sessionB) as unknown as ParcaeClient, chainB);

    const keyA = useQueryTest.buildKey("post", "userA", chainA.__steps);
    const keyB = useQueryTest.buildKey("post", "userB", chainB.__steps);
    expect(useQueryTest.getEntry(keyA)).toBeDefined();
    expect(useQueryTest.getEntry(keyB)).toBeDefined();

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser("userA");

    expect(useQueryTest.getEntry(keyA)).toBeUndefined();
    expect(useQueryTest.getEntry(keyB)).toBeDefined();
  });

  it("is a no-op when passed null (no prior session)", async () => {
    const session = makeSession("u1");
    session.resolve();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-1",
    });
    await prefetch(makeFakeClient(session) as unknown as ParcaeClient, chain);
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(null);

    expect(useQueryTest.getEntry(key)).toBeDefined();
  });
});
