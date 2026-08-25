/**
 * useQuery — an entry must never sit `loading` with no work in flight.
 *
 * `_onResyncRequired` supersedes an in-flight fetch by bumping the
 * entry's generation, so that fetch's resolve AND reject branches both
 * bail without touching `loading`. Recovery then rests entirely on the
 * resync reply — and `recoverResyncEntry` → `scheduleRetry` declines to
 * schedule anything once the last subscriber has unmounted. The entry is
 * left `loading: true`, `fetchPromise: null`, `retryTimer: null`, and the
 * mount effect's old guard refused to refetch anything already marked
 * loading. That combination pulses a skeleton for the life of the
 * process — the mobile Nutrition screen, reported from production.
 *
 * React tier (`ParcaeContext.Provider` + a probe component) because the
 * mount effect is the thing under test; the `__test` surface alone can't
 * reach it.
 */

import { EventEmitter } from "eventemitter3";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, SESSION_BOUNDARY_ERRORS } from "@parcae/model";

import { ConnectionMachine } from "../connection-machine";
import { ParcaeContext } from "../react/context";
import { __test as useQueryTest, useQuery } from "../react/useQuery";
import { SessionMachine } from "../session-machine";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class Post extends Model {
  static type = "post" as const;
  title = "";
}

class FakeClient extends EventEmitter {
  session = new SessionMachine();
  connection = new ConnectionMachine();
  isConnected = true;
  needsSessionRefresh = false;
  resync = vi.fn(async () => [] as any[]);

  subscribe(_event: string, _handler: (...args: any[]) => void): () => void {
    return () => {};
  }

  _emitDiagnostic(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // The stranded-fetch promise is deliberately never settled in some
  // tests; keep node from reporting it as an unhandled rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** A chain whose `find()` the test drives, counting every call. */
function makeChain() {
  const calls: { promise: Promise<any> }[] = [];
  let next: (() => Promise<any>) | null = null;
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
    findCalls: 0,
    /** Queue what the next `find()` returns. */
    setNext(factory: () => Promise<any>) {
      next = factory;
    },
  };
  chain.find = () => {
    chain.findCalls++;
    const promise = next ? next() : deferred<any[]>().promise;
    calls.push({ promise });
    void promise.catch(() => {});
    return promise;
  };
  return chain;
}

function Probe({ chain }: { chain: any }) {
  useQuery(chain);
  return null;
}

function mountProbe(client: FakeClient, chain: any): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(
        ParcaeContext.Provider,
        { value: client as any },
        createElement(Probe, { chain }),
      ),
    );
  });
  return renderer;
}

const flush = () => act(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe("useQuery — stranded loading", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });
  afterEach(() => {
    useQueryTest.resetCache();
    vi.useRealTimers();
  });

  it("refetches on remount after a resync stranded the entry mid-fetch", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    // A fetch that never settles — the socket went away mid-flight.
    const stranded = deferred<any[]>();
    chain.setNext(() => stranded.promise);
    const renderer = mountProbe(client, chain);
    await flush();
    expect(chain.findCalls).toBe(1);

    // Reconnect: the resync supersedes the in-flight fetch, then fails.
    const resync = deferred<any[]>();
    client.resync.mockReturnValueOnce(resync.promise);
    act(() => {
      useQueryTest.onResyncRequired(client as any);
    });

    // The user leaves the screen before the resync lands, so the retry
    // scheduler has no subscriber left to schedule for.
    act(() => {
      renderer.unmount();
    });
    resync.reject(new Error("resync failed"));
    await flush();

    // Nothing is in flight and nothing is scheduled: the superseded
    // fetch will never settle, and the failed resync had no subscriber
    // left to retry for.
    const entry = useQueryTest.getEntry(client as any, key)!;
    expect(entry.fetchPromise).toBeNull();
    expect(entry.retryTimer).toBeNull();
    expect(entry.resyncPending).toBe(false);
    expect(entry.items).toEqual([]);

    // Returning to the screen must restart it. Keyed off `loading` the
    // mount effect issued nothing here, and the skeleton pulsed forever.
    chain.setNext(async () => {
      const items: any[] = [Post.hydrate({} as any, { id: "p1" })];
      Object.defineProperty(items, "__totalCount", {
        value: 1,
        enumerable: false,
      });
      return items;
    });
    mountProbe(client, chain);
    await flush();

    expect(chain.findCalls).toBe(2);
    const settled = useQueryTest.getEntry(client as any, key)!;
    expect(settled.loading).toBe(false);
    expect(settled.items.map((item: any) => item.id)).toEqual(["p1"]);
  });

  it("refetches on remount after retries were exhausted", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    chain.setNext(async () => {
      throw new Error("network down");
    });
    const renderer = mountProbe(client, chain);
    // MAX_RETRIES is 3 on a 1s/3s/10s backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(chain.findCalls).toBe(4);

    const entry = useQueryTest.getEntry(client as any, key)!;
    expect(entry.loading).toBe(false);
    expect(entry.error).not.toBeNull();

    act(() => {
      renderer.unmount();
    });
    chain.setNext(async () => {
      const items: any[] = [];
      Object.defineProperty(items, "__totalCount", {
        value: 0,
        enumerable: false,
      });
      return items;
    });
    mountProbe(client, chain);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The old guard also refused any entry carrying an error, so a
    // screen that failed once stayed failed until the process died.
    expect(chain.findCalls).toBe(5);
    expect(useQueryTest.getEntry(client as any, key)!.error).toBeNull();
  });

  it("clears loading when an authorization-boundary resync has no subscriber to retry for", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    chain.setNext(async () => {
      const items: any[] = [Post.hydrate({} as any, { id: "p1" })];
      Object.defineProperty(items, "__totalCount", {
        value: 1,
        enumerable: false,
      });
      return items;
    });
    const renderer = mountProbe(client, chain);
    await flush();

    const resync = deferred<any[]>();
    client.resync.mockReturnValueOnce(resync.promise);
    act(() => {
      useQueryTest.onResyncRequired(client as any);
    });
    act(() => {
      renderer.unmount();
    });
    resync.reject(new Error(SESSION_BOUNDARY_ERRORS.terminated));
    await flush();

    // Fail-closed blanks the rows, which is correct. Leaving `loading`
    // pinned true with nothing scheduled is not: the next render shows a
    // skeleton that no code path will ever resolve.
    const entry = useQueryTest.getEntry(client as any, key)!;
    expect(entry.items).toEqual([]);
    expect(entry.retryTimer).toBeNull();
    expect(entry.loading).toBe(false);
  });

  it("does not double-fetch while a resync for the entry is still in flight", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    const stranded = deferred<any[]>();
    chain.setNext(() => stranded.promise);
    const renderer = mountProbe(client, chain);
    await flush();
    expect(chain.findCalls).toBe(1);

    const resync = deferred<any[]>();
    client.resync.mockReturnValueOnce(resync.promise);
    act(() => {
      useQueryTest.onResyncRequired(client as any);
    });
    act(() => {
      renderer.unmount();
    });
    // Remount while the resync is still outstanding — it owns the entry,
    // so the mount effect must stay out of its way.
    mountProbe(client, chain);
    await flush();
    expect(chain.findCalls).toBe(1);

    resync.resolve([
      { key, hash: "h1", items: [{ id: "p1" }], totalCount: 1 },
    ]);
    await flush();

    const entry = useQueryTest.getEntry(client as any, key)!;
    expect(entry.loading).toBe(false);
    expect(entry.items.map((item: any) => item.id)).toEqual(["p1"]);
  });
});
