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
    manager = new QuerySubscriptionManager((socketId, event, data) => {
      emitted.push({ socketId, event, data });
    });
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
      const ops = emitted[0]!.data;
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        op: "add",
        id: "p2",
        data: { id: "p2", name: "B" },
      });
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
      const ops = emitted[0]!.data;
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({ op: "remove", id: "p2" });
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
      const ops = emitted[0]!.data;
      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe("update");
      expect(ops[0].id).toBe("p1");
      // Should carry a JSON Patch array, not the full data
      expect(ops[0].patch).toBeDefined();
      expect(ops[0].data).toBeUndefined();
      expect(ops[0].patch).toEqual([
        { op: "replace", path: "/views", value: 42 },
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
      const ops = emitted[0]!.data;
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

      const ops = emitted[0]!.data;
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

      const ops = emitted[0]!.data;
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
      const op = emitted[0]!.data[0];
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

// ── Helper ───────────────────────────────────────────────────────────────────

/** Flush microtask queue so async _reeval completes */
function tick() {
  return new Promise((r) => setTimeout(r, 10));
}
