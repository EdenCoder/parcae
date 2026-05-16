import { describe, it, expect, vi } from "vitest";
import { ModelChangeBus } from "../services/model-change-bus";
import { PubSub } from "../services/pubsub";
import { QuerySubscriptionManager } from "../services/subscriptions";

/**
 * Mirrors the test helper in model-change-bus.test.ts but exists here so
 * this integration test is self-contained. Returns a QueryChain shape
 * that QuerySubscriptionManager.subscribe() understands.
 */
function makeMockQuery(
  modelType: string,
  getResults: () => Record<string, any>[],
  sqlIdentity: string = "default",
) {
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "__modelType") return modelType;
        if (prop === "find") {
          return async () =>
            getResults().map((r) => ({
              __data: r,
              sanitize: () => r,
            }));
        }
        if (prop === "first") {
          return async () => {
            const rows = getResults();
            return rows[0]
              ? { __data: rows[0], sanitize: () => rows[0] }
              : null;
          };
        }
        if (prop === "count") return async () => getResults().length;
        if (prop === "exec") {
          return () => ({
            toSQL: () => ({
              sql: `SELECT * FROM ${modelType}s WHERE ${sqlIdentity}`,
              bindings: [],
            }),
          });
        }
        if (prop === "clone") return () => chain;
        return (..._args: any[]) => chain;
      },
    },
  );
  return chain;
}

describe("cross-replica realtime (integration)", () => {
  it("a notify on replica A re-evaluates a cached query on replica B", async () => {
    // Shared PubSub instance (in-process fallback, no Redis URL).
    // In production this is two PubSub instances sharing the Redis
    // `events` channel; here both replicas attach listeners to the
    // same in-process EventEmitter, which models the same wire shape:
    // an emit on one replica reaches every replica's listener.
    const pubsub = new PubSub({});
    await pubsub.building;

    // Replica A: bus only (this replica originates the write).
    const subsA = new QuerySubscriptionManager(vi.fn());
    const busA = new ModelChangeBus(pubsub, subsA);

    // Replica B: bus + subscription manager + emit sink.
    const emittedB: Array<{ socketId: string; event: string; ops: any[] }> =
      [];
    const subsB = new QuerySubscriptionManager((socketId, event, data) => {
      emittedB.push({ socketId, event, ops: data });
    });
    const busB = new ModelChangeBus(pubsub, subsB);

    // Replica B has a cached query on `test-thing`. Initially the
    // query returns one row.
    let currentRows: Array<{ id: string; name: string }> = [
      { id: "row-1", name: "alpha" },
    ];
    const mockQuery = makeMockQuery("test-thing", () => currentRows);
    const sub = await subsB.subscribe({
      socketId: "socket-1",
      query: mockQuery,
    });
    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]).toEqual({ id: "row-1", name: "alpha" });

    // Originating replica A writes a row (simulated by mutating the
    // result source), then notifies via its bus. This is exactly what
    // BackendAdapter._notifyChange calls in production.
    currentRows = [...currentRows, { id: "row-2", name: "beta" }];
    busA.notify("test-thing");

    // Re-evaluation is fire-and-forget inside onModelChange, so yield
    // to the microtask + timer queues before asserting.
    await new Promise((r) => setTimeout(r, 10));

    // Replica B's subscription manager should have re-evaluated the
    // cached query, diffed against the prior result set, and emitted
    // an `add` op for the new row to its local socket.
    expect(emittedB.length).toBeGreaterThan(0);
    const lastEmit = emittedB[emittedB.length - 1];
    expect(lastEmit.socketId).toBe("socket-1");
    expect(lastEmit.event).toMatch(/^query:/);
    expect(lastEmit.ops).toContainEqual(
      expect.objectContaining({ op: "add", id: "row-2" }),
    );
  });

  it("does not re-dispatch on the originating replica (no double-fire)", async () => {
    const pubsub = new PubSub({});
    await pubsub.building;

    const emittedA: Array<{ socketId: string; event: string; ops: any[] }> =
      [];
    const subsA = new QuerySubscriptionManager((socketId, event, data) => {
      emittedA.push({ socketId, event, ops: data });
    });
    const busA = new ModelChangeBus(pubsub, subsA);

    // Replica A has its own cached query. The originator-id dedup must
    // prevent its bus listener from re-dispatching on its own emit.
    let currentRows: Array<{ id: string; name: string }> = [
      { id: "row-1", name: "alpha" },
    ];
    const mockQuery = makeMockQuery("test-thing", () => currentRows);
    await subsA.subscribe({ socketId: "socket-a", query: mockQuery });

    currentRows = [...currentRows, { id: "row-2", name: "beta" }];
    busA.notify("test-thing");

    await new Promise((r) => setTimeout(r, 10));

    // Exactly one ops emit, from the local fast-path call inside
    // busA.notify() — NOT a second one from the loopback through
    // pubsub.on. If the dedup were broken, we'd see two ops batches
    // for the same change (and the diff against the already-updated
    // cache would yield an empty ops array on the second pass — but
    // the emit would still happen and the count would be wrong).
    expect(emittedA.length).toBe(1);
  });
});
