/**
 * Transaction context tests — withTransaction(), buffer flush on
 * commit, buffer discard on rollback, nested calls.
 *
 * Uses a stub knex instance so we don't need a real DB up. The stub
 * lets us drive commit/rollback paths deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendAdapter } from "../adapters/model";
import { clearHooks, hook } from "../routing/hook";
import { ChangeBus, type Change } from "../services/changeBus";
import { PubSub } from "../services/pubsub";
import {
  activeTransactionHandle,
  bufferChangeIfActive,
  getActiveTransactionFrame,
  runAfterCommitIfActive,
  runAfterRollbackIfActive,
  withTransaction,
} from "../services/transactionContext";

// ─── Stub knex.transaction ───────────────────────────────────────────────────

/**
 * Minimum-viable knex stub. `transaction(fn)` resolves with whatever
 * `fn(trx)` returns and rejects (rolls back) if `fn` throws — same
 * contract as real knex. The `raw` method is a no-op so the
 * setRequestIdGuc branch doesn't break under the stub.
 */
function makeStubKnex() {
  const raw = vi.fn(async (_sql: string, _bindings?: any[]) => undefined);
  const trx: any = { raw };
  return {
    raw,
    transaction: async (fn: (t: any) => Promise<any>) => {
      // Run fn; whatever it returns becomes the result. If fn throws,
      // re-throw so the caller treats it as a rollback (same as real
      // knex.transaction).
      return await fn(trx);
    },
  };
}

function makeAdapterKnex(failCommit = false) {
  const committed = new Map<string, Record<string, any>>();
  const writes: string[] = [];

  const makeHandle = (
    rows: Map<string, Record<string, any>>,
    label: string,
  ): any => {
    const handle: any = (_table: string) => {
      let pending: Record<string, any> | null = null;
      let ids: string[] = [];
      let selected: string | null = null;
      const query: any = {
        insert(row: Record<string, any>) {
          pending = row;
          return query;
        },
        onConflict() {
          return query;
        },
        async merge() {
          writes.push(label);
          rows.set(pending!.id, { ...pending! });
        },
        where(column: string, value: string) {
          if (column === "id") ids = [value];
          return query;
        },
        whereIn(column: string, values: readonly string[]) {
          if (column === "id") ids = [...values];
          return query;
        },
        select(column: string) {
          selected = column;
          return query;
        },
        async first() {
          const row = rows.get(ids[0]!);
          return row && selected ? { [selected]: row[selected] } : row;
        },
        async increment(field: string, amount: number) {
          writes.push(label);
          for (const id of ids) {
            const row = rows.get(id);
            if (row) row[field] = Number(row[field] ?? 0) + amount;
          }
        },
        async decrement(field: string, amount: number) {
          writes.push(label);
          for (const id of ids) {
            const row = rows.get(id);
            if (row) row[field] = Number(row[field] ?? 0) - amount;
          }
        },
      };
      return query;
    };
    handle.raw = vi.fn(async () => undefined);
    return handle;
  };

  const knex = makeHandle(committed, "root");
  knex.transaction = async (fn: (trx: any) => Promise<any>) => {
    const staged = new Map(
      [...committed].map(([id, row]) => [id, { ...row }] as const),
    );
    const trx = makeHandle(staged, "trx");
    const result = await fn(trx);
    if (failCommit) throw new Error("commit failed");
    committed.clear();
    for (const [id, row] of staged) committed.set(id, row);
    return result;
  };

  return { knex, committed, writes };
}

const AdapterModel: any = {
  type: "txitem",
  __schema: { name: "string" },
};

function adapterModel(id: string): any {
  return {
    constructor: AdapterModel,
    id,
    __data: { id, name: id },
    __isNew: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("withTransaction", () => {
  let pubsub: PubSub;
  let bus: ChangeBus;
  let received: Change[];

  beforeEach(() => {
    clearHooks();
    pubsub = new PubSub();
    bus = new ChangeBus({ pubsub });
    received = [];
    bus.on((c) => received.push(c));
  });

  afterEach(async () => {
    clearHooks();
    bus.close();
    await pubsub.close();
  });

  function fakeChange(overrides: Partial<Change> = {}): Change {
    return {
      table: "posts",
      op: "update",
      id: "p1",
      requestId: "req_default",
      source: "hook",
      ...overrides,
    };
  }

  it("opens a frame that buffers Changes via bufferChangeIfActive", async () => {
    expect(getActiveTransactionFrame()).toBeNull();

    const knex = makeStubKnex();
    await withTransaction({ knex, changeBus: bus }, async () => {
      const frame = getActiveTransactionFrame();
      expect(frame).not.toBeNull();
      // Buffering inside the frame returns true and adds to the
      // frame buffer — bus shouldn't see anything yet.
      const buffered = bufferChangeIfActive(
        fakeChange({ requestId: frame!.requestId }),
      );
      expect(buffered).toBe(true);
      expect(received).toHaveLength(0);
    });
    // Frame is closed, change has flushed.
    expect(getActiveTransactionFrame()).toBeNull();
    expect(received).toHaveLength(1);
  });

  it("flushes buffered Changes in order on commit", async () => {
    const knex = makeStubKnex();
    await withTransaction({ knex, changeBus: bus }, async () => {
      bufferChangeIfActive(fakeChange({ id: "1" }));
      bufferChangeIfActive(fakeChange({ id: "2" }));
      bufferChangeIfActive(fakeChange({ id: "3" }));
      expect(received).toHaveLength(0);
    });
    expect(received.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("discards the buffer when the callback throws", async () => {
    const knex = makeStubKnex();
    await expect(
      withTransaction({ knex, changeBus: bus }, async () => {
        bufferChangeIfActive(fakeChange({ id: "ghost" }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(received).toHaveLength(0);
  });

  it("rolls back adapter writes and events through the active transaction handle", async () => {
    const db = makeAdapterKnex();
    const adapter = new BackendAdapter({
      read: db.knex,
      write: db.knex,
      changeBus: bus,
    });

    await expect(
      withTransaction({ knex: db.knex, changeBus: bus }, async () => {
        await adapter.save(adapterModel("rollback-write"));
        throw new Error("rollback adapter write");
      }),
    ).rejects.toThrow("rollback adapter write");

    expect(db.writes).toEqual(["trx"]);
    expect(db.committed.has("rollback-write")).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("does not publish or persist an adapter write when commit fails", async () => {
    const db = makeAdapterKnex(true);
    const adapter = new BackendAdapter({
      read: db.knex,
      write: db.knex,
      changeBus: bus,
    });

    await expect(adapter.save(adapterModel("failed-commit"))).rejects.toThrow(
      "commit failed",
    );

    expect(db.writes).toEqual(["trx"]);
    expect(db.committed.has("failed-commit")).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("runs nested operation cleanups when the outer commit fails", async () => {
    const db = makeAdapterKnex(true);
    const adapter = new BackendAdapter({
      read: db.knex,
      write: db.knex,
      changeBus: bus,
    });
    const cleanup = vi.fn();
    hook.before(AdapterModel, "create", ({ onError }: any) => {
      onError(cleanup);
    });

    await expect(
      withTransaction({ knex: db.knex, changeBus: bus }, async () => {
        await adapter.save(adapterModel("outer-commit-failure"));
      }),
    ).rejects.toThrow("commit failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(db.committed.has("outer-commit-failure")).toBe(false);
  });

  it("rolls back an adapter write when a synchronous after-hook fails", async () => {
    const db = makeAdapterKnex();
    const adapter = new BackendAdapter({
      read: db.knex,
      write: db.knex,
      changeBus: bus,
    });
    hook.after(AdapterModel, "create", () => {
      throw new Error("after hook failed");
    });

    await expect(adapter.save(adapterModel("hook-rollback"))).rejects.toThrow(
      "after hook failed",
    );

    expect(db.committed.has("hook-rollback")).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("publishes one buffered event for each direct counter write", async () => {
    const db = makeAdapterKnex();
    db.committed.set("one", { id: "one", count: 5 });
    db.committed.set("two", { id: "two", count: 7 });
    const adapter = new BackendAdapter({
      read: db.knex,
      write: db.knex,
      changeBus: bus,
    });
    const model = {
      constructor: AdapterModel,
      id: "one",
      __data: { id: "one", count: 5 },
      count: 5,
    };

    await adapter.increment(model, "count", 2);
    expect(model.count).toBe(7);
    expect(received).toHaveLength(1);

    received.length = 0;
    await adapter.decrement(model, "count", 1);
    expect(model.count).toBe(6);
    expect(received).toHaveLength(1);

    received.length = 0;
    await adapter.incrementMany(AdapterModel, ["one", "two"], "count", 3);
    expect(db.committed.get("one")?.count).toBe(9);
    expect(db.committed.get("two")?.count).toBe(10);
    expect(received).toHaveLength(1);
  });

  it("nested calls share the same frame and request-id", async () => {
    const knex = makeStubKnex();
    let outerRid: string | undefined;
    let innerRid: string | undefined;

    await withTransaction({ knex, changeBus: bus }, async () => {
      outerRid = getActiveTransactionFrame()!.requestId;
      bufferChangeIfActive(
        fakeChange({ id: "outer", requestId: outerRid }),
      );
      await withTransaction({ knex, changeBus: bus }, async () => {
        innerRid = getActiveTransactionFrame()!.requestId;
        bufferChangeIfActive(
          fakeChange({ id: "inner", requestId: innerRid }),
        );
      });
      // After the inner exits, frame still exists with depth back at 1.
      expect(getActiveTransactionFrame()).not.toBeNull();
    });

    expect(outerRid).toBe(innerRid);
    expect(received.map((c) => c.id)).toEqual(["outer", "inner"]);
  });

  it("issues a SET LOCAL parcae.request_id when setRequestIdGuc=true", async () => {
    const knex = makeStubKnex();
    let observedRid: string | undefined;
    await withTransaction(
      { knex, changeBus: bus, setRequestIdGuc: true, requestId: "rid_custom" },
      async () => {
        observedRid = getActiveTransactionFrame()!.requestId;
      },
    );
    expect(observedRid).toBe("rid_custom");
    // The stub's raw method should have been called with the
    // set_config statement and the custom request-id binding.
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]![0]).toContain("set_config");
    expect(calls[0]![1]).toEqual(["rid_custom"]);
  });

  it("uses changeBus.newRequestId() when no requestId is passed", async () => {
    const knex = makeStubKnex();
    let observedRid: string | undefined;
    await withTransaction({ knex, changeBus: bus }, async () => {
      observedRid = getActiveTransactionFrame()!.requestId;
    });
    expect(observedRid).toBeDefined();
    expect(observedRid!.startsWith("req_")).toBe(true);
  });

  it("reserves the request id before commit and emits only the post-commit hook change", async () => {
    const raw = vi.fn(async () => undefined);
    const trx = { raw };
    let requestId = "";
    const knex = {
      transaction: async (fn: (handle: any) => Promise<any>) => {
        const result = await fn(trx);
        bus.emit(
          fakeChange({ requestId, source: "listen", id: "dedup-race" }),
        );
        return result;
      },
    };

    await withTransaction({ knex, changeBus: bus }, async () => {
      requestId = getActiveTransactionFrame()!.requestId;
      bufferChangeIfActive(
        fakeChange({ requestId, source: "hook", id: "dedup-race" }),
      );
    });

    expect(received).toEqual([
      expect.objectContaining({ id: "dedup-race", source: "hook" }),
    ]);
  });

  it("does not reserve raw-only transactions before commit", async () => {
    let requestId = "";
    const knex = {
      transaction: async (fn: (handle: any) => Promise<any>) => {
        const result = await fn({ raw: vi.fn(async () => undefined) });
        bus.emit(fakeChange({ requestId, source: "listen", id: "raw-only" }));
        return result;
      },
    };

    await withTransaction({ knex, changeBus: bus }, async () => {
      requestId = getActiveTransactionFrame()!.requestId;
    });

    expect(received).toEqual([
      expect.objectContaining({ id: "raw-only", source: "listen" }),
    ]);
  });

  it("dedupes only hook rows in a mixed hook and raw transaction", async () => {
    let requestId = "";
    const knex = {
      transaction: async (fn: (handle: any) => Promise<any>) => {
        const result = await fn({ raw: vi.fn(async () => undefined) });
        bus.emit(fakeChange({ requestId, source: "listen", id: "hook-row" }));
        bus.emit(fakeChange({ requestId, source: "listen", id: "raw-row" }));
        return result;
      },
    };

    await withTransaction({ knex, changeBus: bus }, async () => {
      requestId = getActiveTransactionFrame()!.requestId;
      bufferChangeIfActive(
        fakeChange({ requestId, source: "hook", id: "hook-row" }),
      );
    });

    expect(received.map((change) => [change.id, change.source])).toEqual([
      ["raw-row", "listen"],
      ["hook-row", "hook"],
    ]);
  });

  it.each([
    ["commit", false],
    ["rollback", true],
  ])("closes frames retained by detached work after %s", async (_label, rollback) => {
    const knex = makeStubKnex();
    const retained: { frame: ReturnType<typeof getActiveTransactionFrame> } = {
      frame: null,
    };
    let detached!: Promise<void>;
    let observed: {
      frame: ReturnType<typeof getActiveTransactionFrame>;
      handle: any;
      buffered: boolean;
      afterCommit: boolean;
      afterRollback: boolean;
    } | null = null;

    const transaction = withTransaction({ knex, changeBus: bus }, async () => {
      retained.frame = getActiveTransactionFrame();
      detached = new Promise<void>((resolve) => {
        setTimeout(() => {
          observed = {
            frame: getActiveTransactionFrame(),
            handle: activeTransactionHandle(),
            buffered: bufferChangeIfActive(fakeChange({ id: "detached" })),
            afterCommit: runAfterCommitIfActive(() => {}),
            afterRollback: runAfterRollbackIfActive(() => {}),
          };
          resolve();
        }, 0);
      });
      if (rollback) throw new Error("rollback detached");
    });

    if (rollback) await expect(transaction).rejects.toThrow("rollback detached");
    else await transaction;
    await detached;

    expect(retained.frame?.state).toBe("closed");
    expect(observed).toEqual({
      frame: null,
      handle: null,
      buffered: false,
      afterCommit: false,
      afterRollback: false,
    });
    expect(received).toHaveLength(0);
  });

  it("bufferChangeIfActive returns false outside any frame", () => {
    const buffered = bufferChangeIfActive(fakeChange());
    expect(buffered).toBe(false);
  });
});
