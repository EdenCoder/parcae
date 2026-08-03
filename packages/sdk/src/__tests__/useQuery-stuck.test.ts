/**
 * useQuery — stuck-loading diagnostic.
 *
 * A hook continuously `loading` for 10s is stuck: either the session
 * never resolved (no cache key can be built, the exact shape of a dead
 * hello) or the entry's fetch/subscribe hung. The hook emits one
 * `query-stuck` diagnostic per mount through the client so the app can
 * report it; it must never fire for queries that resolve, and must
 * cancel on unmount.
 */
import { EventEmitter } from "eventemitter3";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";

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

  subscribe(_event: string, _handler: (...args: any[]) => void): () => void {
    return () => {};
  }

  _emitDiagnostic(event: string, payload: Record<string, unknown>): void {
    this.emit(event, payload);
  }
}

function makeChain(results: Array<{ id: string; title?: string }>): any {
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
  };
  chain.find = async () => {
    const items = results.map((r) => Post.hydrate({} as any, r));
    Object.defineProperty(items, "__totalCount", {
      value: results.length,
      enumerable: false,
    });
    return items;
  };
  return chain;
}

function Probe({ client, chain }: { client: FakeClient; chain: any }) {
  useQuery(chain);
  return null;
}

function mountProbe(client: FakeClient, chain: any): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(
        ParcaeContext.Provider,
        { value: client as any },
        createElement(Probe, { client, chain }),
      ),
    );
  });
  return renderer!;
}

describe("useQuery — stuck-loading diagnostic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useQueryTest.resetCache();
  });
  afterEach(() => {
    useQueryTest.resetCache();
    vi.useRealTimers();
  });

  it("emits query-stuck once when the session never resolves", async () => {
    const client = new FakeClient();
    const events: any[] = [];
    client.on("query-stuck", (e) => events.push(e));

    const renderer = mountProbe(client, makeChain([]));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_900);
    });
    expect(events).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(events).toHaveLength(1);
    expect(events[0].modelType).toBe("post");
    expect(events[0].sessionStatus).toBe("pending");
    expect(events[0].elapsedMs).toBeGreaterThanOrEqual(10_000);

    // One-shot per mount: nothing further while still stuck.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(events).toHaveLength(1);

    act(() => renderer.unmount());
  });

  it("does not emit when unmounted before the threshold", async () => {
    const client = new FakeClient();
    const events: any[] = [];
    client.on("query-stuck", (e) => events.push(e));

    const renderer = mountProbe(client, makeChain([]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => renderer.unmount());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(events).toHaveLength(0);
  });

  it("does not emit for a query that resolves", async () => {
    const client = new FakeClient();
    client.session.resolve("u1");
    const events: any[] = [];
    client.on("query-stuck", (e) => events.push(e));

    const renderer = mountProbe(client, makeChain([{ id: "p1" }]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(events).toHaveLength(0);

    act(() => renderer.unmount());
  });
});
