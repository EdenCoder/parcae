/**
 * Store-core tests — fake chain + fake client, no Lynx runtime.
 *
 * The scenarios mirror the on-device bugs that motivated this package:
 * optimistic echo reconciliation by adopted server id, remove ops,
 * membership-only updates via refetch, and reset/refetch registry
 * behaviour on identity changes and reconnects.
 */

import { SYM_SERVER_MERGE } from "@parcae/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provideClient } from "../client-registry";
import {
  createLiveQuery,
  refetchLiveQueries,
  resetLiveQueries,
  type LiveQueryStore,
  type QueryChain,
} from "../live-query";

interface Row {
  id?: string;
  tmp?: string;
  project?: string;
  [SYM_SERVER_MERGE]?: (data: Record<string, unknown>) => unknown;
}

// ── Fakes ──────────────────────────────────────────────────────────

type OpsHandler = (payload: unknown) => void;

function makeFakeClient() {
  const subs = new Map<string, Set<OpsHandler>>();
  const client = {
    subscribe(event: string, handler: OpsHandler) {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event)!.add(handler);
      return () => subs.get(event)?.delete(handler);
    },
    emit(event: string, payload: unknown) {
      for (const h of subs.get(event) ?? []) h(payload);
    },
    subscriberCount(event: string) {
      return subs.get(event)?.size ?? 0;
    },
  };
  return client;
}

const FakeModel = {
  hydrate(_adapter: unknown, data: Record<string, unknown>): Row {
    return { ...(data as Row) };
  },
};

function makeChain(
  pages: Row[][],
  hash: string | null = "H1",
): { chain: QueryChain<Row>; calls: () => number } {
  let call = 0;
  const chain: QueryChain<Row> = {
    find: async () => {
      const page = pages[Math.min(call, pages.length - 1)] ?? [];
      call++;
      const result = page.map((r) => ({ ...r }));
      if (hash) {
        Object.defineProperty(result, "__queryHash", { value: hash });
      }
      return result;
    },
    __modelClass: FakeModel,
    __adapter: {},
  };
  return { chain, calls: () => call };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function retained(store: LiveQueryStore<Row>): {
  changes: () => number;
  release: () => void;
} {
  let n = 0;
  const release = store.retain(() => n++);
  return { changes: () => n, release };
}

let fakeClient: ReturnType<typeof makeFakeClient>;
const releases: Array<() => void> = [];

beforeEach(() => {
  fakeClient = makeFakeClient();
  // The store only calls `subscribe` on the client.
  provideClient(() => fakeClient as never);
});

afterEach(() => {
  while (releases.length) releases.pop()!();
  vi.useRealTimers();
});

function retainTracked(store: LiveQueryStore<Row>) {
  const r = retained(store);
  releases.push(r.release);
  return r;
}

// ── Fetch + snapshot ───────────────────────────────────────────────

describe("fetch", () => {
  it("first retain triggers the fetch and flips loading → ready", async () => {
    const { chain } = makeChain([[{ id: "a", project: "p1" }]]);
    const store = createLiveQuery<Row>(() => chain);

    expect(store.snapshot().status).toBe("loading");
    retainTracked(store);
    await flush();

    const snap = store.snapshot();
    expect(snap.status).toBe("ready");
    expect(snap.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps ready status (stale items) when a refetch fails", async () => {
    const { chain } = makeChain([[{ id: "a" }]]);
    let fail = false;
    const flaky: QueryChain<Row> = {
      ...chain,
      find: () => (fail ? Promise.reject(new Error("boom")) : chain.find()),
    };
    const store = createLiveQuery<Row>(() => flaky);
    retainTracked(store);
    await flush();

    fail = true;
    store.refetch();
    await flush();

    const snap = store.snapshot();
    expect(snap.status).toBe("ready");
    expect(snap.items.map((i) => i.id)).toEqual(["a"]);
    expect(snap.error?.message).toBe("boom");
  });

  it("reports error status when the first fetch fails", async () => {
    const store = createLiveQuery<Row>(() => ({
      find: () => Promise.reject(new Error("forbidden")),
    }));
    retainTracked(store);
    await flush();

    expect(store.snapshot().status).toBe("error");
  });
});

// ── Ops application ────────────────────────────────────────────────

describe("ops", () => {
  it("applies add and remove ops from the query subscription", async () => {
    const { chain } = makeChain([[{ id: "a" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();

    fakeClient.emit("query:H1", [{ op: "add", id: "b", data: { id: "b" } }]);
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["a", "b"]);

    fakeClient.emit("query:H1", { ops: [{ op: "remove", id: "a" }] });
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["b"]);
  });

  it("merges an add echo into the optimistic instance by adopted id", async () => {
    const { chain } = makeChain([[]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();

    const mergeSpy = vi.fn(function (this: Row, data: Record<string, unknown>) {
      Object.assign(this, data);
      return this;
    });
    // Simulates a model that was save()d: the server-minted id was
    // adopted onto the local instance before the ops echo arrives.
    const local: Row = { id: "server-1", [SYM_SERVER_MERGE]: mergeSpy };
    store.addOptimistic(local);

    fakeClient.emit("query:H1", [
      { op: "add", id: "server-1", data: { id: "server-1", project: "p" } },
    ]);

    const snap = store.snapshot();
    expect(mergeSpy).toHaveBeenCalledOnce();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]).toBe(local); // reference stability
  });

  it("reorders items when the envelope carries an order array", async () => {
    const { chain } = makeChain([[{ id: "a" }, { id: "b" }, { id: "c" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();

    fakeClient.emit("query:H1", { ops: [], order: ["c", "a", "b"] });
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("coalesces update ops into one debounced refetch", async () => {
    vi.useFakeTimers();
    const { chain, calls } = makeChain([[{ id: "a" }], [{ id: "a" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await vi.runAllTimersAsync();
    expect(calls()).toBe(1);

    fakeClient.emit("query:H1", [{ op: "update", id: "a" }]);
    fakeClient.emit("query:H1", [{ op: "update", id: "a" }]);
    await vi.runAllTimersAsync();

    expect(calls()).toBe(2); // one refetch for both update frames
  });

  it("swaps the ops subscription when a refetch returns a new hash", async () => {
    let call = 0;
    const chain: QueryChain<Row> = {
      find: async () => {
        call++;
        const result: Row[] = [];
        Object.defineProperty(result, "__queryHash", {
          value: call === 1 ? "H1" : "H2",
        });
        return result;
      },
      __modelClass: FakeModel,
    };
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();
    expect(fakeClient.subscriberCount("query:H1")).toBe(1);

    store.refetch();
    await flush();
    expect(fakeClient.subscriberCount("query:H1")).toBe(0);
    expect(fakeClient.subscriberCount("query:H2")).toBe(1);
  });
});

// ── Optimistic entries ─────────────────────────────────────────────

describe("optimistic", () => {
  it("shows optimistic rows in the snapshot and drains them on fetch", async () => {
    const { chain } = makeChain([[], [{ id: "x" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();

    store.addOptimistic({ id: "x" });
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["x"]);

    store.refetch();
    await flush();

    // Server row replaced the optimistic one — no duplicate.
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["x"]);
  });

  it("removeOptimistic drops rows from both arrays", async () => {
    const { chain } = makeChain([[{ id: "a" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();
    store.addOptimistic({ id: "b" });

    store.removeOptimistic("a");
    store.removeOptimistic("b");
    expect(store.snapshot().items).toEqual([]);
  });
});

// ── Registry (reset / refetch) ─────────────────────────────────────

describe("registry", () => {
  it("resetLiveQueries clears state and refetches retained stores", async () => {
    const { chain, calls } = makeChain([[{ id: "a" }], [{ id: "b" }]]);
    const store = createLiveQuery<Row>(() => chain);
    retainTracked(store);
    await flush();
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["a"]);

    resetLiveQueries();
    expect(store.snapshot().status).toBe("loading");
    await flush();

    expect(calls()).toBe(2);
    expect(store.snapshot().items.map((i) => i.id)).toEqual(["b"]);
  });

  it("refetchLiveQueries skips stores with no retainers", async () => {
    const { chain, calls } = makeChain([[{ id: "a" }]]);
    const store = createLiveQuery<Row>(() => chain);
    const r = retained(store);
    await flush();
    r.release();

    refetchLiveQueries();
    await flush();
    expect(calls()).toBe(1);
  });
});
