/**
 * Tests for `RefLoader` — request-scoped batching of `findById` calls
 * on the backend so a LIST endpoint that returns 100 posts each with
 * the same `user` ref does ONE `SELECT * FROM users WHERE id IN (...)`
 * query, not 100 individual `WHERE id = ?` queries (DOL-1038).
 *
 * The loader is a thin DataLoader-style batcher:
 *   - Calls within the same microtask coalesce into one batch.
 *   - Each batch groups requests by model type and dedups ids so a
 *     single load call goes out per (type, unique-id-set) pair.
 *   - Subsequent ticks start a fresh batch.
 *
 * These are unit-level tests over the class itself — the integration
 * with `BackendAdapter.findById` + `AsyncLocalStorage` is covered
 * separately in `ref-batching.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RefLoader } from "../services/ref-loader";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RefLoader", () => {
  it("batches concurrent load() calls in the same microtask into one underlying call", async () => {
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, { id, type, name: `name-${id}` });
      return m;
    });
    const loader = new RefLoader(loadByIds);

    // Five concurrent loads of the same type — must coalesce.
    const results = await Promise.all([
      loader.load("user", "a"),
      loader.load("user", "b"),
      loader.load("user", "c"),
      loader.load("user", "d"),
      loader.load("user", "e"),
    ]);

    expect(loadByIds).toHaveBeenCalledTimes(1);
    const [type, ids] = loadByIds.mock.calls[0]!;
    expect(type).toBe("user");
    expect(ids.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(results.map((r: any) => r?.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("deduplicates the same id within a batch — one underlying call, but every caller still gets a result", async () => {
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, { id, type });
      return m;
    });
    const loader = new RefLoader(loadByIds);

    const results = await Promise.all([
      loader.load("post", "p1"),
      loader.load("post", "p1"),
      loader.load("post", "p1"),
      loader.load("post", "p2"),
    ]);

    expect(loadByIds).toHaveBeenCalledTimes(1);
    const ids = loadByIds.mock.calls[0]![1];
    // Underlying query should only fetch the two unique ids, not all 4 requests.
    expect(new Set(ids)).toEqual(new Set(["p1", "p2"]));
    expect(results.map((r: any) => r?.id)).toEqual(["p1", "p1", "p1", "p2"]);
  });

  it("groups requests by type — one underlying call per type", async () => {
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, { id, type });
      return m;
    });
    const loader = new RefLoader(loadByIds);

    await Promise.all([
      loader.load("user", "u1"),
      loader.load("post", "p1"),
      loader.load("user", "u2"),
      loader.load("post", "p2"),
      loader.load("comment", "c1"),
    ]);

    expect(loadByIds).toHaveBeenCalledTimes(3);
    const callsByType = new Map<string, string[]>();
    for (const [type, ids] of loadByIds.mock.calls as Array<[string, string[]]>) {
      callsByType.set(type, ids);
    }
    expect(callsByType.get("user")?.sort()).toEqual(["u1", "u2"]);
    expect(callsByType.get("post")?.sort()).toEqual(["p1", "p2"]);
    expect(callsByType.get("comment")).toEqual(["c1"]);
  });

  it("returns null for ids the batch loader didn't include in its result map", async () => {
    const loadByIds = vi.fn(async (_type: string, ids: string[]) => {
      // Mimic the adapter's behaviour: rows that don't exist are
      // omitted from the result map rather than returned as null.
      const m = new Map<string, unknown>();
      for (const id of ids) {
        if (id !== "missing") m.set(id, { id });
      }
      return m;
    });
    const loader = new RefLoader(loadByIds);

    const [found, missing] = await Promise.all([
      loader.load("user", "ok"),
      loader.load("user", "missing"),
    ]);

    expect((found as any).id).toBe("ok");
    expect(missing).toBeNull();
  });

  it("starts a fresh batch on the next microtask", async () => {
    const loadByIds = vi.fn(async (_type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, { id });
      return m;
    });
    const loader = new RefLoader(loadByIds);

    // First batch: tick 1.
    await Promise.all([loader.load("user", "a"), loader.load("user", "b")]);
    expect(loadByIds).toHaveBeenCalledTimes(1);

    // Yield so the next loader.load() lands on a fresh microtask.
    await Promise.resolve();

    // Second batch: tick 2.
    await Promise.all([loader.load("user", "c"), loader.load("user", "d")]);
    expect(loadByIds).toHaveBeenCalledTimes(2);
    expect(loadByIds.mock.calls[0]![1]).toEqual(["a", "b"]);
    expect(loadByIds.mock.calls[1]![1]).toEqual(["c", "d"]);
  });

  it("propagates errors from the batch loader to every queued caller of the same type", async () => {
    const boom = new Error("batch broke");
    const loadByIds = vi.fn(async (_type: string, _ids: string[]) => {
      throw boom;
    });
    const loader = new RefLoader(loadByIds);

    const results = await Promise.allSettled([
      loader.load("user", "a"),
      loader.load("user", "b"),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBe(boom);
    }
  });

  it("doesn't poison other-type batches when one type's loader throws", async () => {
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      if (type === "user") throw new Error("user broke");
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, { id, type });
      return m;
    });
    const loader = new RefLoader(loadByIds);

    const [userResult, postResult] = await Promise.allSettled([
      loader.load("user", "u1"),
      loader.load("post", "p1"),
    ]);

    expect(userResult.status).toBe("rejected");
    expect(postResult.status).toBe("fulfilled");
    if (postResult.status === "fulfilled") {
      expect((postResult.value as any).id).toBe("p1");
    }
  });

  it("returns null when load() is called with a falsy id", async () => {
    const loadByIds = vi.fn();
    const loader = new RefLoader(loadByIds);

    expect(await loader.load("user", "")).toBeNull();
    expect(loadByIds).not.toHaveBeenCalled();
  });
});
