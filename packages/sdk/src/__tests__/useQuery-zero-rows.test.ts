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

describe("useQuery — a query with zero rows is loaded", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });
  afterEach(() => {
    useQueryTest.resetCache();
    vi.useRealTimers();
  });

  const emptyResult = async () => {
    const items: any[] = [];
    Object.defineProperty(items, "__totalCount", {
      value: 0,
      enumerable: false,
    });
    return items;
  };

  it("does not flip back to loading when a zero-row query refetches", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();
    const key = useQueryTest.buildKey("post", "u1", chain.__steps);

    chain.setNext(emptyResult);
    mountProbe(client, chain);
    await flush();

    const entry = useQueryTest.getEntry(client as any, key)!;
    expect(entry.loading).toBe(false);

    // A refetch on a loaded-but-empty query must not put the screen back
    // behind a skeleton. Nutrition refetches on every focus.
    const seen: boolean[] = [];
    const release = useQueryTest.retain(client as any, key, () => {
      seen.push(useQueryTest.getEntry(client as any, key)!.loading);
    });
    chain.setNext(emptyResult);
    useQueryTest.fetch(key, chain, client as any);
    await flush();
    release();

    expect(seen).not.toContain(true);
  });

  it("does not refetch a zero-row query on every remount", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const chain = makeChain();

    chain.setNext(emptyResult);
    const first = mountProbe(client, chain);
    await flush();
    expect(chain.findCalls).toBe(1);

    act(() => {
      first.unmount();
    });
    chain.setNext(emptyResult);
    mountProbe(client, chain);
    await flush();

    // Zero rows is an answer. Treating it as "never fetched" re-queries
    // the server every time the screen is opened.
    expect(chain.findCalls).toBe(1);
  });
});
