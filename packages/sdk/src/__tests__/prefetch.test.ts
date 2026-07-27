/**
 * prefetch() — session-safe cache priming for useQuery.
 *
 * Contract pinned here:
 *
 *   1. Returns items from cache when the entry is already loaded.
 *   2. Fires a fresh fetch when the entry doesn't exist.
 *   3. Multiple parallel prefetches share one underlying wire request.
 *   4. **Session safety**: waits for server-confirmed reconciliation before
 *      building the owner/client-scoped cache key.
 *   5. `waitForSession: false` is only allowed for an already-reconciled
 *      session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { prefetch, __test as useQueryTest } from "../react/useQuery";
import type { ParcaeClient } from "../client";
import { SessionMachine } from "../session-machine";

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
}

interface StubSession {
  ready: Promise<void>;
  resolve: () => void;
  beginReconciliation: () => void;
  subscribe: (listener: () => void) => () => void;
  state: {
    status: "pending" | "anonymous" | "authenticated";
    userId: string | null;
    version: number;
  };
}

function makeSession(initialUserId: string | null): StubSession {
  let resolveFn: () => void = () => {};
  const listeners = new Set<() => void>();
  const makeReady = () =>
    new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
  const session: StubSession = {
    ready: Promise.resolve(),
    resolve: () => {
      session.state.status = session.state.userId
        ? "authenticated"
        : "anonymous";
      resolveFn();
      for (const listener of listeners) listener();
    },
    beginReconciliation: () => {
      session.state.status = "pending";
      session.state.version++;
      session.ready = makeReady();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: { status: "pending", userId: initialUserId, version: 0 },
  };
  session.ready = makeReady();
  return session;
}

interface FakeClient extends EventEmitter {
  session: StubSession;
  subscriptions: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  emitQueryOps(hash: string, ops: unknown[]): void;
  resync: ReturnType<typeof vi.fn>;
  isConnected: boolean;
  needsSessionRefresh: boolean;
  send: ReturnType<typeof vi.fn>;
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
  ee.resync = vi.fn(async () => []);
  ee.isConnected = true;
  ee.needsSessionRefresh = false;
  ee.send = vi.fn();
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

    const anonKey = useQueryTest.buildKey(
      "post",
      null,
      chain.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();

    session.state.userId = "u-authsafe";
    session.resolve();

    await pending;

    expect(findSpy).toHaveBeenCalledTimes(1);
    const userKey = useQueryTest.buildKey(
      "post",
      "u-authsafe",
      chain.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    expect(useQueryTest.getEntry(userKey)).toBeDefined();
    expect(useQueryTest.getEntry(anonKey)).toBeUndefined();
  });

  it("skips the session gate when waitForSession: false", async () => {
    const session = makeSession(null);
    session.resolve();
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
    const anonKey = useQueryTest.buildKey(
      "post",
      null,
      chain.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    expect(useQueryTest.getEntry(anonKey)).toBeDefined();
  });

  it("rejects waitForSession:false while authorization is pending", async () => {
    const session = makeSession(null);
    const client = makeFakeClient(session);
    const chain = makeChain({
      results: [{ id: "must-not-fetch" }],
      queryHash: "h-pending",
    });

    await expect(
      prefetch(client as unknown as ParcaeClient, chain, {
        waitForSession: false,
      }),
    ).rejects.toThrow("already-reconciled session");
    expect(
      useQueryTest.getEntry(
        useQueryTest.buildKey(
          "post",
          null,
          chain.__steps,
          true,
          client as unknown as ParcaeClient,
        ),
      ),
    ).toBeUndefined();
  });

  it("rejects waitForSession:false after the session is terminated", async () => {
    const session = makeSession(null);
    session.state.status = "terminated" as any;
    const client = makeFakeClient(session);
    const chain = makeChain({
      results: [{ id: "must-not-fetch" }],
      queryHash: "h-terminated",
    });

    await expect(
      prefetch(client as unknown as ParcaeClient, chain, {
        waitForSession: false,
      }),
    ).rejects.toThrow("already-reconciled session");
  });

  it("builds the key only after the latest owner reconciliation completes", async () => {
    const session = makeSession("user-a");
    session.resolve();
    const client = makeFakeClient(session) as unknown as ParcaeClient & {
      awaitSessionReconciled: ReturnType<typeof vi.fn>;
    };
    let releaseReconciliation: () => void = () => undefined;
    client.awaitSessionReconciled = vi.fn(
      () =>
        new Promise<{ userId: string }>((resolve) => {
          releaseReconciliation = () => resolve({ userId: "user-b" });
        }),
    );
    const findSpy = vi.fn();
    const chain = makeChain({
      results: [{ id: "owned-by-b" }],
      queryHash: "h-user-b",
      findSpy,
    });

    const pending = prefetch(client, chain);
    await Promise.resolve();
    expect(findSpy).not.toHaveBeenCalled();

    session.state.userId = "user-b";
    session.state.status = "authenticated";
    releaseReconciliation();
    await pending;

    const userAKey = useQueryTest.buildKey(
      "post",
      "user-a",
      chain.__steps,
      true,
      client,
    );
    const userBKey = useQueryTest.buildKey(
      "post",
      "user-b",
      chain.__steps,
      true,
      client,
    );
    expect(useQueryTest.getEntry(userAKey)).toBeUndefined();
    expect(useQueryTest.getEntry(userBKey)?.items[0]?.id).toBe("owned-by-b");
  });

  it("isolates identical owner/query caches and resync by client backend", async () => {
    const sessionA = makeSession("shared-user");
    const sessionB = makeSession("shared-user");
    sessionA.resolve();
    sessionB.resolve();
    const clientA = makeFakeClient(sessionA) as unknown as ParcaeClient;
    const clientB = makeFakeClient(sessionB) as unknown as ParcaeClient;
    const chainA = makeChain({
      results: [{ id: "backend-a" }],
      queryHash: "h-a",
    });
    const chainB = makeChain({
      results: [{ id: "backend-b" }],
      queryHash: "h-b",
    });

    await prefetch(clientA, chainA);
    await prefetch(clientB, chainB);
    const keyA = useQueryTest.buildKey(
      "post",
      "shared-user",
      chainA.__steps,
      true,
      clientA,
    );
    const keyB = useQueryTest.buildKey(
      "post",
      "shared-user",
      chainB.__steps,
      true,
      clientB,
    );
    expect(keyA).not.toBe(keyB);
    expect(useQueryTest.getEntry(keyA)?.items[0]?.id).toBe("backend-a");
    expect(useQueryTest.getEntry(keyB)?.items[0]?.id).toBe("backend-b");

    const releaseA = useQueryTest.retain(keyA, () => {});
    const releaseB = useQueryTest.retain(keyB, () => {});
    useQueryTest.onResyncRequired(clientA);
    expect((clientA as any).resync).toHaveBeenCalledOnce();
    expect((clientA as any).resync.mock.calls[0]![0]).toHaveLength(1);
    expect((clientB as any).resync).not.toHaveBeenCalled();

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(clientA, "shared-user");
    expect(useQueryTest.getEntry(keyA)).toBeUndefined();
    expect(useQueryTest.getEntry(keyB)?.items[0]?.id).toBe("backend-b");
    releaseA();
    releaseB();
  });

  it("fails every resync entry closed when one is denied and another is omitted", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const chainA = makeChain({
      results: [{ id: "a", title: "patient a" }],
      queryHash: "h-a",
    });
    const chainB = makeChain({
      results: [{ id: "b", title: "patient b" }],
      queryHash: "h-b",
    });
    chainB.__steps = [{ method: "where", args: [{ status: "inactive" }] }];

    await prefetch(client as unknown as ParcaeClient, chainA);
    await prefetch(client as unknown as ParcaeClient, chainB);
    const keyA = useQueryTest.buildKey(
      "post",
      "u1",
      chainA.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    const keyB = useQueryTest.buildKey(
      "post",
      "u1",
      chainB.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    const entryA = useQueryTest.getEntry(keyA)!;
    const entryB = useQueryTest.getEntry(keyB)!;
    const renderedA = entryA.items;
    const renderedB = entryB.items;
    const releaseA = useQueryTest.retain(keyA, () => {
      throw new Error("consumer listener failed");
    });
    const secondListener = vi.fn();
    const releaseB = useQueryTest.retain(keyB, secondListener);
    client.resync.mockResolvedValueOnce([
      {
        key: keyA,
        hash: null,
        items: [],
        totalCount: 0,
        authorized: false,
      },
    ]);

    useQueryTest.onResyncRequired(client as unknown as ParcaeClient);
    await Promise.resolve();
    await Promise.resolve();

    expect(renderedA).toHaveLength(0);
    expect(renderedB).toHaveLength(0);
    expect(entryA.queryHash).toBeNull();
    expect(entryB.queryHash).toBeNull();
    expect(secondListener).toHaveBeenCalled();
    releaseA();
    releaseB();
  });

  it("refetches a denied hashless dynamic entry on the next prefetch", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const firstFind = vi.fn();
    const recoveryFind = vi.fn();
    const firstChain = makeChain({
      results: [{ id: "before", title: "patient before" }],
      queryHash: "h-before",
      findSpy: firstFind,
    });

    await prefetch(client as unknown as ParcaeClient, firstChain);
    const key = useQueryTest.buildKey(
      "post",
      "u1",
      firstChain.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    const release = useQueryTest.retain(key, () => {});
    client.resync.mockResolvedValueOnce([
      {
        key,
        hash: null,
        items: [],
        totalCount: 0,
        authorized: false,
      },
    ]);

    useQueryTest.onResyncRequired(client as unknown as ParcaeClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(useQueryTest.getEntry(key)).toMatchObject({
      queryHash: null,
      loading: false,
      error: null,
    });

    const recoveryChain = makeChain({
      results: [{ id: "after", title: "patient after" }],
      queryHash: "h-after",
      findSpy: recoveryFind,
    });
    const recovered = await prefetch(
      client as unknown as ParcaeClient,
      recoveryChain,
    );

    expect(firstFind).toHaveBeenCalledTimes(1);
    expect(recoveryFind).toHaveBeenCalledTimes(1);
    expect(recovered.map((item: any) => item.id)).toEqual(["after"]);
    expect(useQueryTest.getEntry(key)?.queryHash).toBe("h-after");
    release();
  });

  it("fails every live entry closed when the resync RPC rejects", async () => {
    const session = makeSession("u1");
    session.resolve();
    const client = makeFakeClient(session);
    const chainA = makeChain({
      results: [{ id: "a", title: "patient a" }],
      queryHash: "h-a",
    });
    const chainB = makeChain({
      results: [{ id: "b", title: "patient b" }],
      queryHash: "h-b",
    });
    chainB.__steps = [{ method: "where", args: [{ status: "inactive" }] }];

    await prefetch(client as unknown as ParcaeClient, chainA);
    await prefetch(client as unknown as ParcaeClient, chainB);
    const keyA = useQueryTest.buildKey(
      "post",
      "u1",
      chainA.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    const keyB = useQueryTest.buildKey(
      "post",
      "u1",
      chainB.__steps,
      true,
      client as unknown as ParcaeClient,
    );
    const entryA = useQueryTest.getEntry(keyA)!;
    const entryB = useQueryTest.getEntry(keyB)!;
    const renderedA = entryA.items;
    const renderedB = entryB.items;
    const releaseA = useQueryTest.retain(keyA, () => {});
    const releaseB = useQueryTest.retain(keyB, () => {});
    client.resync.mockRejectedValueOnce(new Error("transport failed"));

    useQueryTest.onResyncRequired(client as unknown as ParcaeClient);
    await Promise.resolve();
    await Promise.resolve();

    expect(renderedA).toHaveLength(0);
    expect(renderedB).toHaveLength(0);
    expect(entryA.error?.message).toBe("Parcae query resync failed");
    expect(entryB.error?.message).toBe("Parcae query resync failed");
    releaseA();
    releaseB();
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

    const key = useQueryTest.buildKey(
      "post",
      "u1",
      chain.__steps,
      true,
      client as unknown as ParcaeClient,
    );
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

    const key = useQueryTest.buildKey(
      "post",
      "u1",
      buildChain().__steps,
      true,
      client as unknown as ParcaeClient,
    );

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

  it("drops only entries owned by the prior user", async () => {
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

    const keyA = useQueryTest.buildKey(
      "post",
      "userA",
      chainA.__steps,
      true,
      clientA,
    );
    const keyB = useQueryTest.buildKey(
      "post",
      "userB",
      chainB.__steps,
      true,
      clientB,
    );
    expect(useQueryTest.getEntry(keyA)).toBeDefined();
    expect(useQueryTest.getEntry(keyB)).toBeDefined();

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(clientA, "userA");

    expect(useQueryTest.getEntry(keyA)).toBeUndefined();
    expect(useQueryTest.getEntry(keyB)).toBeDefined();
  });

  it("purges anonymous entries without touching authenticated owners", async () => {
    const session = makeSession(null);
    session.resolve();
    const anonymousChain = makeChain({
      results: [{ id: "anon-p1" }],
      queryHash: "h-1",
    });
    const anonymousClient = makeFakeClient(session) as unknown as ParcaeClient;
    await prefetch(anonymousClient, anonymousChain);
    const authenticatedSession = makeSession("u1");
    authenticatedSession.resolve();
    const authenticatedChain = makeChain({
      results: [{ id: "user-p1" }],
      queryHash: "h-2",
    });
    const authenticatedClient = makeFakeClient(
      authenticatedSession,
    ) as unknown as ParcaeClient;
    await prefetch(authenticatedClient, authenticatedChain);
    const anonymousKey = useQueryTest.buildKey(
      "post",
      null,
      anonymousChain.__steps,
      true,
      anonymousClient,
    );
    const authenticatedKey = useQueryTest.buildKey(
      "post",
      "u1",
      authenticatedChain.__steps,
      true,
      authenticatedClient,
    );

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(anonymousClient, null);

    expect(useQueryTest.getEntry(anonymousKey)).toBeUndefined();
    expect(useQueryTest.getEntry(authenticatedKey)).toBeDefined();
  });

  it("matches the exact owner rather than user text inside query steps", async () => {
    const session = makeSession("userB");
    session.resolve();
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    const chain = makeChain({
      results: [{ id: "user-b-result" }],
      queryHash: "h-user-b",
    });
    chain.__steps = [{ method: "where", args: ["notes", "contains", "userA"] }];
    await prefetch(client, chain);
    const key = useQueryTest.buildKey(
      "post",
      "userB",
      chain.__steps,
      true,
      client,
    );

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, "userA");

    expect(useQueryTest.getEntry(key)?.items[0]?.id).toBe("user-b-result");
  });

  it("rejects a pending prefetch and ignores its late PHI result after purge", async () => {
    const session = makeSession("userA");
    session.resolve();
    const client = makeFakeClient(session) as unknown as ParcaeClient;
    let resolveFind: (items: any[]) => void = () => undefined;
    let findStarted = false;
    const chain: any = {
      __modelType: "post",
      __modelClass: Post,
      __steps: [{ method: "where", args: [{ owner: "userA" }] }],
      __adapter: null,
      find: () =>
        new Promise<any[]>((resolve) => {
          findStarted = true;
          resolveFind = resolve;
        }),
    };

    const pending = prefetch(client, chain);
    const rejection = expect(pending).rejects.toThrow("authorization boundary");
    await vi.waitFor(() => expect(findStarted).toBe(true));
    const key = useQueryTest.buildKey(
      "post",
      "userA",
      chain.__steps,
      true,
      client,
    );

    const { _purgeCacheForUser } = await import("../react/useQuery");
    _purgeCacheForUser(client, "userA");
    await rejection;

    const lateItems = [
      Post.hydrate({} as any, { id: "late-user-a-phi", title: "secret" }),
    ];
    Object.defineProperty(lateItems, "__queryHash", { value: "late-hash" });
    resolveFind(lateItems);
    await Promise.resolve();
    await Promise.resolve();

    expect(useQueryTest.getEntry(key)).toBeUndefined();
    expect((client as any).subscriptions).toHaveLength(0);
  });

  it("scrubs direct-client prefetch data when its session starts changing owner", async () => {
    const session = new SessionMachine();
    session.resolve("userA");
    const throwingListener = vi.fn(() => {
      throw new Error("prior-owner-phi");
    });
    session.subscribe(throwingListener);
    const client = makeFakeClient(
      session as unknown as StubSession,
    ) as unknown as ParcaeClient;
    const chain = makeChain({
      results: [{ id: "user-a-phi", title: "secret" }],
      queryHash: "h-user-a",
    });
    await prefetch(client, chain);
    const keyA = useQueryTest.buildKey(
      "post",
      "userA",
      chain.__steps,
      true,
      client,
    );
    const oldItems = useQueryTest.getEntry(keyA)!.items;

    expect(() => session.beginReconciliation()).not.toThrow();

    expect(throwingListener).toHaveBeenCalled();
    expect(oldItems).toHaveLength(0);
    expect(useQueryTest.getEntry(keyA)).toBeUndefined();
    expect((client as any).send).not.toHaveBeenCalled();
    session.resolve("userB");
  });
});
