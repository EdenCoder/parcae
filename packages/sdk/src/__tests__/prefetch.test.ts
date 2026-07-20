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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it("does not hang when a subscribed result has no query hash", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "",
      findSpy,
    });

    await prefetch(client as unknown as ParcaeClient, chain);
    const second = await prefetch(client as unknown as ParcaeClient, chain);

    expect(second).toHaveLength(1);
    expect(findSpy).toHaveBeenCalledOnce();
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
    expect(useQueryTest.getEntry(client as any, anonKey)).toBeUndefined();

    session.state.userId = "u-authsafe";
    session.resolve();

    await pending;

    expect(findSpy).toHaveBeenCalledTimes(1);
    const userKey = useQueryTest.buildKey(
      "post",
      "u-authsafe",
      chain.__steps,
    );
    expect(useQueryTest.getEntry(client as any, userKey)).toBeDefined();
    expect(useQueryTest.getEntry(client as any, anonKey)).toBeUndefined();
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
    expect(useQueryTest.getEntry(client as any, anonKey)).toBeDefined();
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
    const entry = useQueryTest.getEntry(client as any, key);
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

  it("isolates identical query keys by client identity", async () => {
    const sessionA = makeSession("u1");
    const sessionB = makeSession("u1");
    sessionA.resolve();
    sessionB.resolve();
    const clientA = makeFakeClient(sessionA) as unknown as ParcaeClient;
    const clientB = makeFakeClient(sessionB) as unknown as ParcaeClient;
    const chainA = makeChain({
      results: [{ id: "p1", title: "client A" }],
      queryHash: "hash-a",
    });
    const chainB = makeChain({
      results: [{ id: "p1", title: "client B" }],
      queryHash: "hash-b",
    });

    await Promise.all([prefetch(clientA, chainA), prefetch(clientB, chainB)]);

    const key = useQueryTest.buildKey("post", "u1", chainA.__steps);
    const entryA = useQueryTest.getEntry(clientA, key)!;
    const entryB = useQueryTest.getEntry(clientB, key)!;
    expect(entryA).not.toBe(entryB);
    expect(entryA.items[0].title).toBe("client A");
    expect(entryB.items[0].title).toBe("client B");
  });

  it("ignores a fetch response after its cache entry is purged and replaced", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    const oldResult = deferred<any[]>();
    const oldChain = makeChain({ results: [], queryHash: "old" });
    oldChain.find = () => oldResult.promise;
    const key = useQueryTest.buildKey("post", "u1", oldChain.__steps);
    const releaseOld = useQueryTest.retain(client, key, () => {});
    useQueryTest.fetch(key, oldChain, client);

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, "u1");
    const freshChain = makeChain({
      results: [{ id: "fresh", title: "new" }],
      queryHash: "fresh",
    });
    const releaseFresh = useQueryTest.retain(client, key, () => {});
    useQueryTest.fetch(key, freshChain, client);
    await new Promise((resolve) => setImmediate(resolve));

    oldResult.resolve([Post.hydrate({} as any, { id: "stale", title: "old" })]);
    await Promise.resolve();
    await Promise.resolve();

    const entry = useQueryTest.getEntry(client, key)!;
    expect(entry.items.map((item) => item.id)).toEqual(["fresh"]);
    releaseOld();
    releaseFresh();
  });

  it("rejects a pending prefetch when its identity cache is purged", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    const result = deferred<any[]>();
    const chain = makeChain({ results: [], queryHash: "pending" });
    chain.find = () => result.promise;
    const pending = prefetch(client, chain);
    const rejection = expect(pending).rejects.toThrow("Query identity changed");
    await Promise.resolve();

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, "u1");

    await rejection;
    result.resolve([]);
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

    const release1 = useQueryTest.retain(client as any, key, () => {});
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
    const clientA = makeFakeClient(sessionA) as unknown as ParcaeClient;
    await prefetch(clientA, chainA);

    const sessionB = makeSession("userB");
    sessionB.resolve();
    const clientB = makeFakeClient(sessionB) as unknown as ParcaeClient;
    await prefetch(clientB, chainB);

    const keyA = useQueryTest.buildKey("post", "userA", chainA.__steps);
    const keyB = useQueryTest.buildKey("post", "userB", chainB.__steps);
    expect(useQueryTest.getEntry(clientA, keyA)).toBeDefined();
    expect(useQueryTest.getEntry(clientB, keyB)).toBeDefined();

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(clientA, "userA");

    expect(useQueryTest.getEntry(clientA, keyA)).toBeUndefined();
    expect(useQueryTest.getEntry(clientB, keyB)).toBeDefined();
  });

  it("does not drop authenticated entries when purging anonymous data", async () => {
    const session = makeSession("u1");
    session.resolve();
    const chain = makeChain({
      results: [{ id: "p1" }],
      queryHash: "h-1",
    });
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    await prefetch(client, chain);
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, null);

    expect(useQueryTest.getEntry(client, key)).toBeDefined();
  });

  it("seeds the authenticated entry from the anonymous pool on sign-in (no skeleton flash)", async () => {
    const session = makeSession(null);
    session.resolve();
    const chain = makeChain({
      results: [{ id: "p1", title: "public" }],
      queryHash: "h-anon",
    });
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    await prefetch(client, chain);
    const anonKey = useQueryTest.buildKey("post", null, chain.__steps);
    expect(useQueryTest.getEntry(client, anonKey)).toBeDefined();

    // Sign-in: anonymous → authenticated pools the old entry instead
    // of disposing it.
    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, null, "u1");
    expect(useQueryTest.getEntry(client, anonKey)).toBeUndefined();

    // The first mount under the new identity seeds from the pool:
    // items present, loading false, and a background refetch still
    // fires (chain is unset until the mount effect runs).
    const authedKey = useQueryTest.buildKey("post", "u1", chain.__steps);
    const release = useQueryTest.retain(client, authedKey, () => {});
    const seeded = useQueryTest.getEntry(client, authedKey)!;
    expect(seeded.items.map((item: any) => item.id)).toEqual(["p1"]);
    expect(seeded.loading).toBe(false);
    expect(seeded.chain).toBeNull();

    useQueryTest.fetch(authedKey, chain, client);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seeded.loading).toBe(false);
    expect(seeded.items.map((item: any) => item.id)).toEqual(["p1"]);
    release();
  });

  it("never seeds across scoped identities (sign-out / account switch)", async () => {
    const session = makeSession("u1");
    session.resolve();
    const chain = makeChain({
      results: [{ id: "secret" }],
      queryHash: "h-u1",
    });
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    await prefetch(client, chain);

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, "u1", "u2");

    const otherKey = useQueryTest.buildKey("post", "u2", chain.__steps);
    const release = useQueryTest.retain(client, otherKey, () => {});
    const fresh = useQueryTest.getEntry(client, otherKey)!;
    expect(fresh.items).toEqual([]);
    expect(fresh.loading).toBe(true);
    release();
  });
});
