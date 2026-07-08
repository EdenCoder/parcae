import { describe, it, expect, beforeEach, vi } from "vitest";
import { QuerySubscriptionManager } from "../services/subscriptions";

// ─── Mock Data ───────────────────────────────────────────────────────────────

function row(id: string, data: Record<string, any> = {}) {
  return { id, ...data };
}

// ─── Mock Query Chain ────────────────────────────────────────────────────────

/**
 * Creates a mock QueryChain that returns results from a mutable source.
 * Supports exec().toSQL() for hashing, clone() for re-evaluation,
 * and __modelType for type indexing.
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
        // All chainable methods return the chain
        return (..._args: any[]) => chain;
      },
    },
  );
  return chain;
}

function makePrivateUserQuery(getCredits: () => number) {
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "__modelType") return "user";
        if (prop === "find") {
          return async () => [
            {
              id: "u1",
              credits: getCredits(),
              sanitize: (user?: { id: string }) => {
                if (user?.id === "u1") {
                  return { id: "u1", credits: getCredits() };
                }
                return { id: "u1" };
              },
            },
          ];
        }
        if (prop === "exec") {
          return () => ({
            toSQL: () => ({
              sql: "SELECT * FROM users WHERE id = ?",
              bindings: ["u1"],
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

// ─── Helper to create queries with mutable results ───────────────────────────

function createQuerySource(initialResults: Record<string, any>[] = []) {
  let currentResults = initialResults;
  return {
    setResults(results: Record<string, any>[]) {
      currentResults = results;
    },
    query(modelType: string, sqlIdentity?: string) {
      return makeMockQuery(modelType, () => currentResults, sqlIdentity);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("QuerySubscriptionManager", () => {
  let source: ReturnType<typeof createQuerySource>;
  let emitted: Array<{ socketId: string; event: string; data: any }>;
  let manager: QuerySubscriptionManager;

  beforeEach(() => {
    source = createQuerySource([]);
    emitted = [];
    // The bulk of the existing tests rely on `await tick()` (a 10ms
    // setTimeout) flushing the re-eval cycle synchronously after
    // `onModelChange`. The 25/100ms default debounce windows would
    // break that. Drop both to 0 for the shared test fixture so we
    // keep the existing assertions intact — the dedicated
    // `coalescing` describe block constructs its own managers with
    // realistic windows.
    manager = new QuerySubscriptionManager(
      (socketId, event, data) => {
        emitted.push({ socketId, event, data });
      },
      { debounceMs: 0, maxWaitMs: 0 },
    );
  });

  // ── Subscribe ──────────────────────────────────────────────────────

  describe("subscribe", () => {
    it("should return initial query results and a hash", async () => {
      source.setResults([
        row("p1", { name: "Project 1" }),
        row("p2", { name: "Project 2" }),
      ]);

      const sub = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      expect(sub.hash).toBeTruthy();
      expect(sub.hash.length).toBe(16);
      expect(sub.items).toHaveLength(2);
      expect(sub.items[0]).toEqual({ id: "p1", name: "Project 1" });
      expect(sub.items[1]).toEqual({ id: "p2", name: "Project 2" });
    });

    it("should deduplicate subscriptions with same query", async () => {
      source.setResults([row("p1")]);

      const sub1 = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      const sub2 = await manager.subscribe({
        socketId: "s2",
        query: source.query("project"),
      });

      expect(sub1.hash).toBe(sub2.hash);
      expect(manager.stats.queries).toBe(1);
      expect(manager.stats.subscribers).toBe(2);
    });

    it("should sanitize cached subscriptions and re-evals with the request user", async () => {
      let credits = 1000;
      const query = makePrivateUserQuery(() => credits);

      const owner = await manager.subscribe({
        socketId: "s1",
        query,
        user: { id: "u1" },
      });
      const other = await manager.subscribe({
        socketId: "s2",
        query,
        user: { id: "u2" },
      });

      expect(owner.hash).not.toBe(other.hash);
      expect(owner.items[0]).toEqual({ id: "u1", credits: 1000 });
      expect(other.items[0]).toEqual({ id: "u1" });

      credits = 750;
      manager.onModelChange("user");
      await tick();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.socketId).toBe("s1");
      expect(emitted[0]!.event).toBe(`query:${owner.hash}`);
      expect(emitted[0]!.data.ops).toEqual([
        {
          op: "update",
          id: "u1",
          patch: [{ op: "replace", path: "/credits", value: 750 }],
        },
      ]);
    });

    it("should create separate subscriptions for different queries", async () => {
      source.setResults([row("p1")]);

      await manager.subscribe({
        socketId: "s1",
        query: source.query("project", "status = 'active'"),
      });

      await manager.subscribe({
        socketId: "s1",
        query: source.query("project", "status = 'draft'"),
      });

      expect(manager.stats.queries).toBe(2);
    });

    it("should create separate subscriptions for different model types", async () => {
      source.setResults([row("p1")]);

      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s1",
        query: source.query("file"),
      });

      expect(manager.stats.queries).toBe(2);
    });

    it("caps subscriptions per socket and returns empty items on overflow", async () => {
      // Use a small explicit cap so we don't burn time creating 500
      // distinct queries (the default in production). The
      // configurability itself is what's being tested — runaway
      // detection at the limit is observable at any cap size.
      const CAP = 10;
      const cappedManager = new QuerySubscriptionManager(
        (socketId, event, data) => {
          emitted.push({ socketId, event, data });
        },
        { debounceMs: 0, maxWaitMs: 0, maxSubscriptionsPerSocket: CAP },
      );
      source.setResults([row("p1")]);
      for (let i = 0; i < CAP; i++) {
        await cappedManager.subscribe({
          socketId: "attacker",
          query: source.query("project", `bucket_${i}`),
        });
      }
      expect(cappedManager.stats.queries).toBe(CAP);

      // The (CAP+1)th subscription is rejected — returns the hash so
      // the client can correlate but with an empty items list.
      const overflow = await cappedManager.subscribe({
        socketId: "attacker",
        query: source.query("project", `bucket_overflow`),
      });
      expect(overflow.items).toEqual([]);
      // The rejected subscription was NOT cached server-side.
      expect(cappedManager.stats.queries).toBe(CAP);

      // A DIFFERENT socket isn't affected by attacker's quota.
      const otherSocket = await cappedManager.subscribe({
        socketId: "honest",
        query: source.query("project", `bucket_overflow`),
      });
      expect(otherSocket.items).toHaveLength(1);
    });

    it("re-subscribing to a cached hash on the same socket doesn't count against the cap", async () => {
      const CAP = 10;
      const cappedManager = new QuerySubscriptionManager(
        (socketId, event, data) => {
          emitted.push({ socketId, event, data });
        },
        { debounceMs: 0, maxWaitMs: 0, maxSubscriptionsPerSocket: CAP },
      );
      source.setResults([row("p1")]);
      // Fill to the cap.
      for (let i = 0; i < CAP; i++) {
        await cappedManager.subscribe({
          socketId: "s1",
          query: source.query("project", `b_${i}`),
        });
      }
      // Re-subscribing to one we already have → success.
      const dup = await cappedManager.subscribe({
        socketId: "s1",
        query: source.query("project", `b_5`),
      });
      expect(dup.items).toHaveLength(1);
    });
  });

  // ── Unsubscribe ────────────────────────────────────────────────────

  describe("unsubscribe", () => {
    it("should remove a socket from a query subscription", async () => {
      source.setResults([row("p1")]);
      const sub = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      manager.unsubscribe("s1", sub.hash);

      // Query should be cleaned up (no subscribers left)
      expect(manager.stats.queries).toBe(0);
      expect(manager.stats.subscribers).toBe(0);
    });

    it("should keep query alive if other subscribers remain", async () => {
      source.setResults([row("p1")]);
      const sub = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s2",
        query: source.query("project"),
      });

      manager.unsubscribe("s1", sub.hash);

      expect(manager.stats.queries).toBe(1);
      expect(manager.stats.subscribers).toBe(1);
    });

    it("unsubscribeAll should clean up all queries for a socket", async () => {
      source.setResults([row("p1")]);

      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s1",
        query: source.query("file"),
      });

      manager.unsubscribeAll("s1");

      expect(manager.stats.queries).toBe(0);
      expect(manager.stats.sockets).toBe(0);
    });
  });

  // ── onModelChange — the core diff engine ───────────────────────────

  describe("onModelChange", () => {
    it("should emit nothing when data has not changed", async () => {
      const items = [row("p1", { name: "A" }), row("p2", { name: "B" })];
      source.setResults(items);

      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Re-eval with same data
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(0);
    });

    it("should emit 'add' op when a new item appears in results", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // New item appears
      source.setResults([row("p1", { name: "A" }), row("p2", { name: "B" })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const ops = emitted[0]!.data.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        op: "add",
        id: "p2",
        data: { id: "p2", name: "B" },
      });
      // Membership changed → order envelope present.
      expect(emitted[0]!.data.order).toEqual(["p1", "p2"]);
    });

    it("should emit 'remove' op when an item disappears from results", async () => {
      source.setResults([row("p1", { name: "A" }), row("p2", { name: "B" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // p2 no longer matches
      source.setResults([row("p1", { name: "A" })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const ops = emitted[0]!.data.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({ op: "remove", id: "p2" });
      // Membership changed → order envelope present.
      expect(emitted[0]!.data.order).toEqual(["p1"]);
    });

    it("should emit 'update' op with JSON Patch when an item's data changes", async () => {
      source.setResults([row("p1", { name: "A", views: 10 })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // p1's data changed
      source.setResults([row("p1", { name: "A", views: 42 })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const ops = emitted[0]!.data.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe("update");
      expect(ops[0].id).toBe("p1");
      // Should carry a JSON Patch array, not the full data
      expect(ops[0].patch).toBeDefined();
      expect(ops[0].data).toBeUndefined();
      expect(ops[0].patch).toEqual([
        { op: "replace", path: "/views", value: 42 },
      ]);
      // Stable membership + stable order → no `order` envelope.
      expect(emitted[0]!.data.order).toBeUndefined();
    });

    it("should not emit update ops for updatedAt-only changes", async () => {
      source.setResults([
        row("p1", {
          name: "A",
          updatedAt: "2026-05-15T07:57:00.000Z",
          references: {
            nodes: [{ id: "r1", updatedAt: "2026-05-15T07:57:01.000Z" }],
          },
        }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      source.setResults([
        row("p1", {
          name: "A",
          updatedAt: "2026-05-15T07:58:00.000Z",
          references: {
            nodes: [{ id: "r1", updatedAt: "2026-05-15T07:58:01.000Z" }],
          },
        }),
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(0);
    });

    it("should strip updatedAt paths from mixed update patches", async () => {
      source.setResults([
        row("p1", {
          name: "A",
          updatedAt: "2026-05-15T07:57:00.000Z",
          references: {
            nodes: [{ id: "r1", updatedAt: "2026-05-15T07:57:01.000Z" }],
          },
        }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      source.setResults([
        row("p1", {
          name: "A-updated",
          updatedAt: "2026-05-15T07:58:00.000Z",
          references: {
            nodes: [{ id: "r1", updatedAt: "2026-05-15T07:58:01.000Z" }],
          },
        }),
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.data.ops[0].patch).toEqual([
        { op: "replace", path: "/name", value: "A-updated" },
      ]);
    });

    it("should emit multiple ops in a single event (add + remove + update)", async () => {
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B" }),
        row("p3", { name: "C" }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      source.setResults([
        row("p1", { name: "A-updated" }), // update
        // p2 removed
        row("p3", { name: "C" }), // unchanged
        row("p4", { name: "D" }), // add
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const ops = emitted[0]!.data.ops;
      expect(ops).toHaveLength(3);

      const byOp = new Map(ops.map((o: any) => [o.id, o]));

      const p1Op = byOp.get("p1") as any;
      expect(p1Op.op).toBe("update");
      expect(p1Op.patch).toEqual([
        { op: "replace", path: "/name", value: "A-updated" },
      ]);
      expect(p1Op.data).toBeUndefined();

      expect(byOp.get("p2")).toEqual({ op: "remove", id: "p2" });
      expect(byOp.get("p4")).toEqual({
        op: "add",
        id: "p4",
        data: { id: "p4", name: "D" },
      });
    });

    it("should only emit to subscribed sockets, not all sockets", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s2",
        query: source.query("project"),
      });

      source.setResults([row("p1", { name: "A-updated" })]);
      manager.onModelChange("project");
      await tick();

      // Both s1 and s2 should get the same ops
      expect(emitted).toHaveLength(2);
      expect(emitted[0]!.socketId).toBe("s1");
      expect(emitted[1]!.socketId).toBe("s2");
      expect(emitted[0]!.data).toEqual(emitted[1]!.data);
    });

    it("should NOT emit to sockets subscribed to a different model type", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s2",
        query: source.query("file"),
      });

      source.setResults([row("p1", { name: "A-updated" })]);
      // Only project changed
      manager.onModelChange("project");
      await tick();

      // Only s1 should get the emission (project subscriber)
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.socketId).toBe("s1");
    });

    it("should emit correct event name with query hash", async () => {
      source.setResults([row("p1", { name: "A" })]);
      const sub = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      source.setResults([row("p1", { name: "A-updated" })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted[0]!.event).toBe(`query:${sub.hash}`);
    });

    it("should not emit after socket unsubscribes", async () => {
      source.setResults([row("p1", { name: "A" })]);
      const sub = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      manager.unsubscribe("s1", sub.hash);

      source.setResults([row("p1", { name: "A-updated" })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(0);
    });
  });

  // ── Minimal data transfer ──────────────────────────────────────────

  describe("minimal data transfer", () => {
    it("should only include patch in update ops and nothing in remove", async () => {
      source.setResults([row("p1", { name: "A" }), row("p2", { name: "B" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Remove p1, update p2
      source.setResults([row("p2", { name: "B-updated" })]);
      manager.onModelChange("project");
      await tick();

      const ops = emitted[0]!.data.ops;
      const removeOp = ops.find((o: any) => o.op === "remove");
      const updateOp = ops.find((o: any) => o.op === "update");

      // Remove op should NOT carry any data — just the id
      expect(removeOp).toEqual({ op: "remove", id: "p1" });
      expect(removeOp.data).toBeUndefined();

      // Update op should carry a JSON Patch array, not the full data
      expect(updateOp.data).toBeUndefined();
      expect(updateOp.patch).toEqual([
        { op: "replace", path: "/name", value: "B-updated" },
      ]);
    });

    it("should not re-send unchanged items", async () => {
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B" }),
        row("p3", { name: "C" }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Only p2 changed, p1 and p3 are the same
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B-updated" }),
        row("p3", { name: "C" }),
      ]);
      manager.onModelChange("project");
      await tick();

      const ops = emitted[0]!.data.ops;
      // Only ONE op for p2 — not 3 ops for all items
      expect(ops).toHaveLength(1);
      expect(ops[0].id).toBe("p2");
      expect(ops[0].op).toBe("update");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle onModelChange for a type with no subscriptions", () => {
      // Should not throw
      manager.onModelChange("nonexistent");
      expect(emitted).toHaveLength(0);
    });

    it("should handle unsubscribe for non-existent hash", () => {
      // Should not throw
      manager.unsubscribe("s1", "nonexistent");
    });

    it("should handle unsubscribeAll for non-existent socket", () => {
      // Should not throw
      manager.unsubscribeAll("nonexistent");
    });

    it("should update cached results after reeval for next diff", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // First change
      source.setResults([row("p1", { name: "B" })]);
      manager.onModelChange("project");
      await tick();

      emitted.length = 0;

      // Second change — diff should be against "B", not "A"
      source.setResults([row("p1", { name: "C" })]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const op = emitted[0]!.data.ops[0];
      expect(op.op).toBe("update");
      expect(op.id).toBe("p1");
      expect(op.patch).toEqual([{ op: "replace", path: "/name", value: "C" }]);
    });

    it("should not emit if reeval returns same results after a previous change", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Change to B
      source.setResults([row("p1", { name: "B" })]);
      manager.onModelChange("project");
      await tick();

      emitted.length = 0;

      // "Change" but data is still B — no diff
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(0);
    });
  });

  // ── Ordered-id emission ────────────────────────────────────────────

  describe("order envelope", () => {
    it("emits order array on add when membership changes", async () => {
      source.setResults([row("p1", { name: "A" }), row("p3", { name: "C" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // p2 inserted between p1 and p3 — client needs the new order to
      // place it correctly rather than appending to the end.
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B" }),
        row("p3", { name: "C" }),
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const envelope = emitted[0]!.data;
      expect(envelope.ops).toHaveLength(1);
      expect(envelope.ops[0].op).toBe("add");
      expect(envelope.ops[0].id).toBe("p2");
      expect(envelope.order).toEqual(["p1", "p2", "p3"]);
    });

    it("emits order array when only ordering changes (no membership change)", async () => {
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B" }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Same membership, swapped order (e.g. orderBy on a mutable field).
      source.setResults([
        row("p2", { name: "B" }),
        row("p1", { name: "A" }),
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      const envelope = emitted[0]!.data;
      // No data changed, but the ORDER changed — no ops, just order.
      expect(envelope.ops).toEqual([]);
      expect(envelope.order).toEqual(["p2", "p1"]);
    });

    it("omits order when membership and order are both stable", async () => {
      source.setResults([
        row("p1", { name: "A" }),
        row("p2", { name: "B" }),
      ]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Only p1 contents change. Order is identical.
      source.setResults([
        row("p1", { name: "A2" }),
        row("p2", { name: "B" }),
      ]);
      manager.onModelChange("project");
      await tick();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.data.order).toBeUndefined();
    });
  });

  // ── Coalescing (debounce + max-wait) ──────────────────────────────

  describe("coalescing", () => {
    it("collapses a burst of onModelChange into a single re-eval", async () => {
      // Use realistic windows so we observe coalescing in practice.
      const fast = new QuerySubscriptionManager(
        (socketId, event, data) => {
          emitted.push({ socketId, event, data });
        },
        { debounceMs: 30, maxWaitMs: 120 },
      );

      source.setResults([row("p1", { name: "A" })]);
      await fast.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Eight rapid signals in a row — only ONE re-eval should fire,
      // and it should reflect the FINAL state of the source.
      source.setResults([row("p1", { name: "A8" })]);
      for (let i = 0; i < 8; i++) fast.onModelChange("project");

      // Well after debounce window (30ms) but inside max-wait (120ms).
      await new Promise((r) => setTimeout(r, 70));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.data.ops[0].patch).toEqual([
        { op: "replace", path: "/name", value: "A8" },
      ]);
    });

    it("max-wait forces a re-eval during a sustained write storm", async () => {
      const fast = new QuerySubscriptionManager(
        (socketId, event, data) => {
          emitted.push({ socketId, event, data });
        },
        { debounceMs: 30, maxWaitMs: 80 },
      );

      source.setResults([row("p1", { name: "A" })]);
      await fast.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Push a new signal every 20ms so the debounce timer never gets
      // to fire. The max-wait ceiling has to break the deadlock.
      source.setResults([row("p1", { name: "A!" })]);
      const t0 = Date.now();
      const interval = setInterval(() => {
        fast.onModelChange("project");
      }, 20);

      // Wait long enough that the max-wait (80ms) must have fired but
      // less than enough for debounce alone to ever land.
      await new Promise((r) => setTimeout(r, 140));
      clearInterval(interval);
      const elapsed = Date.now() - t0;

      expect(emitted.length).toBeGreaterThanOrEqual(1);
      expect(emitted[0]!.data.ops[0].patch).toEqual([
        { op: "replace", path: "/name", value: "A!" },
      ]);
      // Sanity — the first emission landed before we cleared.
      expect(elapsed).toBeLessThanOrEqual(160);
    });

    it("respects per-Model `realtime` override", async () => {
      // The default mock-query Proxy intercepts every prop including
      // `__modelClass`, so we can't just patch one in. Build a small
      // plain-object query that exposes the minimum surface the
      // manager needs PLUS a real `__modelClass.realtime`.
      let resultsFor = [row("p1", { name: "A" })];
      const buildQuery = (modelClass: { realtime?: any }) => {
        const q: any = {
          __modelType: "project",
          __modelClass: modelClass,
          find: async () =>
            resultsFor.map((r) => ({
              __data: r,
              sanitize: () => r,
            })),
          exec: () => ({
            sql: "SELECT * FROM projects WHERE realtime_override",
            bindings: [],
            toSQL: () => ({
              sql: "SELECT * FROM projects WHERE realtime_override",
              bindings: [],
            }),
          }),
          clone: () => q,
        };
        return q;
      };

      const ownEmitted: any[] = [];
      const m = new QuerySubscriptionManager(
        (socketId, event, data) => {
          ownEmitted.push({ socketId, event, data });
        },
        // Default windows are 25/100ms — Model.realtime overrides.
      );

      await m.subscribe({
        socketId: "s1",
        query: buildQuery({ realtime: { debounceMs: 200, maxWaitMs: 400 } }),
      });

      resultsFor = [row("p1", { name: "B" })];
      m.onModelChange("project");

      // Under the default 100ms max-wait the re-eval would have fired
      // already. Under the override (400ms) it has NOT.
      await new Promise((r) => setTimeout(r, 120));
      expect(ownEmitted).toHaveLength(0);

      // Wait through the override's debounce.
      await new Promise((r) => setTimeout(r, 200));
      expect(ownEmitted).toHaveLength(1);
    });
  });

  // ── Force-refresh (drift poll) ────────────────────────────────────

  describe("force-refresh", () => {
    it("rebuilds the cached result and emits drift to all subscribers", async () => {
      // Set up two subscribers on the same query.
      source.setResults([row("p1", { name: "A" })]);
      const sub1 = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });
      await manager.subscribe({
        socketId: "s2",
        query: source.query("project"),
      });
      // Both sockets share one cache entry.
      expect(manager.stats.queries).toBe(1);

      // Simulate drift: an external write changes the row but the
      // hook-path notification never arrived (e.g. cross-process
      // event lost). The cache still thinks p1 is "A".
      source.setResults([row("p1", { name: "A-drifted" })]);

      // s1 polls with force: true. The drift is detected, every
      // subscriber receives the update, and the response carries
      // the freshly-rebuilt items.
      const force = await manager.subscribe(
        { socketId: "s1", query: source.query("project") },
        { force: true },
      );

      expect(force.hash).toBe(sub1.hash);
      expect(force.items).toEqual([{ id: "p1", name: "A-drifted" }]);

      // Both sockets received a `query:{hash}` emission with the
      // drift op.
      const s1Emits = emitted.filter((e) => e.socketId === "s1");
      const s2Emits = emitted.filter((e) => e.socketId === "s2");
      expect(s1Emits).toHaveLength(1);
      expect(s2Emits).toHaveLength(1);
      expect(s1Emits[0]!.data.ops).toEqual([
        {
          op: "update",
          id: "p1",
          patch: [{ op: "replace", path: "/name", value: "A-drifted" }],
        },
      ]);
    });

    it("does nothing when force is false", async () => {
      source.setResults([row("p1", { name: "A" })]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Drift simulated but no force.
      source.setResults([row("p1", { name: "A-drifted" })]);
      const refetch = await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      // Stale cached items — no DB re-execution happened.
      expect(refetch.items).toEqual([{ id: "p1", name: "A" }]);
      expect(emitted).toHaveLength(0);
    });

    it("waits for an in-flight re-eval instead of racing it", async () => {
      // Gated find(): pauses inside the body while the gate is
      // closed so we can hold a re-eval mid-flight.
      let gateOpen = true;
      let findCalls = 0;
      const waiters: Array<() => void> = [];
      let results = [row("p1", { name: "A" })];

      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "__modelType") return "project";
            if (prop === "find") {
              return async () => {
                findCalls++;
                if (!gateOpen) {
                  await new Promise<void>((r) => waiters.push(r));
                }
                return results.map((r) => ({ __data: r, sanitize: () => r }));
              };
            }
            if (prop === "exec") {
              return () => ({ toSQL: () => ({ sql: "gated", bindings: [] }) });
            }
            if (prop === "clone") return () => chain;
            return (..._args: any[]) => chain;
          },
        },
      );

      await manager.subscribe({ socketId: "s1", query: chain });
      expect(findCalls).toBe(1);

      // A write lands; the (0ms-window) re-eval starts and pauses
      // inside the gated find().
      gateOpen = false;
      manager.onModelChange("project");
      await new Promise((r) => setTimeout(r, 1));
      expect(findCalls).toBe(2);

      // The drift poll arrives mid-re-eval. It must NOT launch a
      // concurrent find() on the same cached query — two concurrent
      // `_reeval`s would diff against (and swap) the same cached
      // result. It waits for the in-flight run, then runs a fresh
      // one: the in-flight read may predate the drift being polled.
      results = [row("p1", { name: "A-drifted" })];
      const forcePromise = manager.subscribe(
        { socketId: "s1", query: chain },
        { force: true },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(findCalls).toBe(2);

      gateOpen = true;
      waiters.shift()!();
      const force = await forcePromise;
      expect(findCalls).toBe(3);
      expect(force.items).toEqual([{ id: "p1", name: "A-drifted" }]);
    });

    it("bounds concurrent force re-evals with the reevalConcurrency cap", async () => {
      // Drift polls are timer-driven — every client fires one per
      // poll interval — so unlike the request-scoped initial load
      // they MUST honour the same semaphore as debounced re-evals.
      let gateOpen = true;
      let inFlight = 0;
      let peak = 0;
      const waiters: Array<() => void> = [];
      const source = createQuerySource([row("p1")]);

      const makeGatedQuery = (sql: string) => {
        const chain: any = new Proxy(
          {},
          {
            get(_t, prop: string) {
              if (prop === "__modelType") return "project";
              if (prop === "find") {
                return async () => {
                  inFlight++;
                  if (inFlight > peak) peak = inFlight;
                  if (!gateOpen) {
                    await new Promise<void>((r) => waiters.push(r));
                  }
                  inFlight--;
                  return source.query("project").find();
                };
              }
              if (prop === "exec") {
                return () => ({ toSQL: () => ({ sql, bindings: [] }) });
              }
              if (prop === "clone") return () => chain;
              return (..._args: any[]) => chain;
            },
          },
        );
        return chain;
      };

      const REEVAL_CAP = 2;
      const m = new QuerySubscriptionManager(() => {}, {
        debounceMs: 0,
        maxWaitMs: 0,
        reevalConcurrency: REEVAL_CAP,
      });

      const N = 6;
      const queries = Array.from({ length: N }, (_, i) =>
        makeGatedQuery(`sql_${i}`),
      );
      for (const query of queries) {
        await m.subscribe({ socketId: "s1", query });
      }

      gateOpen = false;
      peak = 0;
      const polls = queries.map((query) =>
        m.subscribe({ socketId: "s1", query }, { force: true }),
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(peak).toBe(REEVAL_CAP);

      while (waiters.length > 0) {
        waiters.shift()!();
        await new Promise((r) => setTimeout(r, 1));
        expect(peak).toBeLessThanOrEqual(REEVAL_CAP);
      }
      await Promise.all(polls);
      expect(m.reevalInFlight).toBe(0);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────

  describe("stats", () => {
    it("should track query/subscriber/socket counts", async () => {
      expect(manager.stats).toEqual({
        queries: 0,
        subscribers: 0,
        sockets: 0,
      });

      source.setResults([row("p1")]);
      await manager.subscribe({
        socketId: "s1",
        query: source.query("project"),
      });

      expect(manager.stats).toEqual({
        queries: 1,
        subscribers: 1,
        sockets: 1,
      });

      await manager.subscribe({
        socketId: "s2",
        query: source.query("project"),
      });

      expect(manager.stats).toEqual({
        queries: 1,
        subscribers: 2,
        sockets: 2,
      });
    });
  });
});

// ─── DOL-1047: concurrency cap + Socket.IO rooms ────────────────────────────
//
// Three new contracts pinned here:
//
//   1. Re-eval semaphore — a burst of `_scheduleReeval` calls across N
//      distinct cached queries does NOT launch N simultaneous DB
//      round-trips. The manager caps in-flight re-evals at
//      `reevalConcurrency` (default 8), so the worst-case pool load
//      from a write-storm stays bounded.
//
//   2. Socket.IO room broadcast — when the constructor is given an
//      `emitToRoom` callback (and `joinRoom`/`leaveRoom`), every
//      subscriber for a given cached query joins `query:${hash}` and
//      re-eval emits ONCE via the room instead of N×emitToSocket.
//
//   3. Per-row clone — `jsonClone` (JSON.parse(JSON.stringify(...)))
//      gets replaced with a single recursive walker that converts
//      Date → ISO string but skips the intermediate string
//      materialisation. Behavioural smoke: dates still come back as
//      ISO strings in the cached result.

describe("QuerySubscriptionManager — re-eval concurrency cap (DOL-1047)", () => {
  it("limits concurrent in-flight re-evals to `reevalConcurrency`", async () => {
    const source = createQuerySource([row("p1")]);

    // Gated `find()` — pauses inside the body until we explicitly
    // release it, recording its in-flight contribution while paused.
    // The first `find()` per query runs during `subscribe`'s initial
    // load and is released immediately so the subscribe loop can
    // make progress; subsequent `find()`s are the re-eval bodies
    // whose concurrency we want to observe.
    let gateOpen = true;
    let inFlight = 0;
    let peak = 0;
    const waiters: Array<() => void> = [];

    const makeGatedQuery = (sql: string) => {
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "__modelType") return "project";
            if (prop === "find") {
              return async () => {
                inFlight++;
                if (inFlight > peak) peak = inFlight;
                if (!gateOpen) {
                  await new Promise<void>((resolve) =>
                    waiters.push(resolve),
                  );
                }
                inFlight--;
                return source.query("project").find();
              };
            }
            if (prop === "exec") {
              return () => ({ toSQL: () => ({ sql, bindings: [] }) });
            }
            if (prop === "clone") return () => chain;
            return (..._args: any[]) => chain;
          },
        },
      );
      return chain;
    };

    const REEVAL_CAP = 3;
    const m = new QuerySubscriptionManager(() => {}, {
      debounceMs: 0,
      maxWaitMs: 0,
      reevalConcurrency: REEVAL_CAP,
    });

    // Phase 1 — subscribe N queries with the gate OPEN so the
    // initial `_execQuery` returns immediately.
    const N = 12;
    for (let i = 0; i < N; i++) {
      await m.subscribe({ socketId: "s1", query: makeGatedQuery(`sql_${i}`) });
    }
    expect(peak).toBe(1); // sanity — initial loads ran one at a time

    // Phase 2 — close the gate, reset stats, trigger a re-eval burst.
    gateOpen = false;
    peak = 0;
    m.onModelChange("project");
    await new Promise((r) => setTimeout(r, 5));

    // With cap=REEVAL_CAP, at most REEVAL_CAP `_execQuery` bodies
    // should be paused-and-waiting in the gate at the same time.
    expect(peak).toBe(REEVAL_CAP);
    expect(m.reevalInFlight).toBe(REEVAL_CAP);

    // Drain the waiters in chunks and verify the semaphore lets the
    // next batch in as old ones finish — never exceeding the cap.
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      next();
      await new Promise((r) => setTimeout(r, 1));
      expect(peak).toBeLessThanOrEqual(REEVAL_CAP);
    }
  });
});

describe("QuerySubscriptionManager — Socket.IO room broadcast (DOL-1047)", () => {
  it("when emitToRoom is provided, emits ONCE per cached query (not per-subscriber)", async () => {
    const source = createQuerySource([row("p1", { name: "first" })]);
    const perSocket: Array<{ socketId: string; event: string }> = [];
    const perRoom: Array<{ room: string; event: string; data: any }> = [];
    const joins: Array<{ socketId: string; room: string }> = [];
    const leaves: Array<{ socketId: string; room: string }> = [];

    const m = new QuerySubscriptionManager(
      {
        emitToSocket: (socketId, event) => {
          perSocket.push({ socketId, event });
        },
        emitToRoom: (room, event, data) => {
          perRoom.push({ room, event, data });
        },
        joinRoom: (socketId, room) => {
          joins.push({ socketId, room });
        },
        leaveRoom: (socketId, room) => {
          leaves.push({ socketId, room });
        },
      },
      { debounceMs: 0, maxWaitMs: 0 },
    );

    const sub1 = await m.subscribe({
      socketId: "s1",
      query: source.query("project"),
    });
    await m.subscribe({
      socketId: "s2",
      query: source.query("project"),
    });
    await m.subscribe({
      socketId: "s3",
      query: source.query("project"),
    });

    // Joining the room is done at subscribe-time so the manager
    // doesn't need a socket reference when it later broadcasts.
    expect(joins).toEqual([
      { socketId: "s1", room: `query:${sub1.hash}` },
      { socketId: "s2", room: `query:${sub1.hash}` },
      { socketId: "s3", room: `query:${sub1.hash}` },
    ]);

    // Trigger a re-eval that changes the data.
    source.setResults([row("p1", { name: "second" })]);
    m.onModelChange("project");
    await new Promise((r) => setTimeout(r, 10));

    // Single room broadcast — not N per-socket emits.
    expect(perRoom).toHaveLength(1);
    expect(perRoom[0]!.room).toBe(`query:${sub1.hash}`);
    expect(perRoom[0]!.event).toBe(`query:${sub1.hash}`);
    expect(perSocket).toHaveLength(0);

    // Unsubscribe must mirror the join with a leave.
    m.unsubscribe("s2", sub1.hash);
    expect(leaves).toContainEqual({
      socketId: "s2",
      room: `query:${sub1.hash}`,
    });
  });

  it("falls back to per-socket emit when only the legacy emitToSocket callback is provided", async () => {
    const source = createQuerySource([row("p1", { name: "first" })]);
    const perSocket: Array<{ socketId: string; event: string }> = [];

    const m = new QuerySubscriptionManager(
      (socketId, event) => {
        perSocket.push({ socketId, event });
      },
      { debounceMs: 0, maxWaitMs: 0 },
    );

    const sub = await m.subscribe({
      socketId: "s1",
      query: source.query("project"),
    });
    await m.subscribe({
      socketId: "s2",
      query: source.query("project"),
    });

    source.setResults([row("p1", { name: "second" })]);
    m.onModelChange("project");
    await new Promise((r) => setTimeout(r, 10));

    // Backward-compat path: one emit per subscriber.
    expect(perSocket).toEqual([
      { socketId: "s1", event: `query:${sub.hash}` },
      { socketId: "s2", event: `query:${sub.hash}` },
    ]);
  });
});

describe("QuerySubscriptionManager — Date safety on re-eval clone (DOL-1047)", () => {
  it("preserves Date → ISO string coercion on rows after re-eval", async () => {
    const source = createQuerySource([
      row("p1", {
        name: "first",
        updatedAt: new Date("2024-01-01T00:00:00Z"),
      }),
    ]);
    const m = new QuerySubscriptionManager(
      () => {},
      { debounceMs: 0, maxWaitMs: 0 },
    );

    const sub = await m.subscribe({
      socketId: "s1",
      query: source.query("project"),
    });
    // The cached result must hold ISO strings, not Date instances —
    // matches the contract `jsonClone` (now `dateSafeClone`) gives.
    expect(sub.items[0]!.updatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(typeof sub.items[0]!.updatedAt).toBe("string");
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

/** Flush microtask queue so async _reeval completes */
function tick() {
  return new Promise((r) => setTimeout(r, 10));
}
