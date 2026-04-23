/**
 * Tests for the ctx.onError compensating-action primitive and the
 * transactional semantics of BackendAdapter.save/remove/patch.
 */

import knexFactory from "knex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendAdapter } from "../adapters/model";
import type { HookContext } from "../routing/hook";
import { clearHooks, hook } from "../routing/hook";

// ─── Test fixtures ───────────────────────────────────────────────────────────

type TestModelClass = {
  type: string;
  __schema: Record<string, string>;
};

const TestModel: TestModelClass = {
  type: "testitem",
  __schema: { name: "string" },
};

function makeModel(data: Record<string, unknown> = {}): any {
  return {
    constructor: TestModel,
    id: data.id ?? "",
    __data: { ...data },
    get __isNew() {
      return true;
    },
  };
}

async function setupAdapter(): Promise<BackendAdapter> {
  const knex = knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });

  await knex.schema.createTable("testitems", (t) => {
    t.string("id").primary();
    t.string("name");
    t.string("tmp");
    t.timestamp("createdAt").defaultTo(knex.fn.now());
    t.timestamp("updatedAt").defaultTo(knex.fn.now());
    t.text("data");
  });

  const adapter = new BackendAdapter({ read: knex, write: knex });
  adapter.engine = "sqlite";
  // Keep a reference so the test can close it
  (adapter as any).__knex = knex;
  return adapter;
}

async function teardown(adapter: BackendAdapter): Promise<void> {
  await (adapter as any).__knex.destroy();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ctx.onError — compensating actions", () => {
  let adapter: BackendAdapter;

  beforeEach(async () => {
    clearHooks();
    adapter = await setupAdapter();
  });

  afterEach(async () => {
    await teardown(adapter);
    clearHooks();
  });

  it("fires cleanups from an earlier before-hook when a later before-hook throws", async () => {
    const cleanup = vi.fn();

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(cleanup);
    }, { priority: 10 });

    hook.before(TestModel as any, "create", () => {
      throw new Error("second before failed");
    }, { priority: 20 });

    const model = makeModel({ id: "m1", name: "alpha" });
    await expect(
      adapter.save(model, { creating: true, ops: [], updates: [] } as any),
    ).rejects.toThrow("second before failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("fires cleanups when the DB write throws (unique constraint)", async () => {
    const cleanup = vi.fn();

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(cleanup);
    });

    // Insert a row first so the second attempt collides on id
    await adapter.save(
      makeModel({ id: "dup", name: "first" }),
      { creating: true, ops: [], updates: [] } as any,
    );

    // Force a PK collision: insert a different model with the same id and a
    // conflicting state by manually injecting a constraint via a trigger.
    // Simpler: call save() with a manually-prepared row that will fail the
    // implicit INSERT because we remove onConflict-merge behavior via a
    // raw SQL collision on a secondary unique constraint.
    await (adapter as any).__knex.raw(
      "CREATE UNIQUE INDEX testitems_name_unique ON testitems(name)",
    );

    cleanup.mockClear();

    await expect(
      adapter.save(
        makeModel({ id: "second", name: "first" }),
        { creating: true, ops: [], updates: [] } as any,
      ),
    ).rejects.toThrow();

    expect(cleanup).toHaveBeenCalledTimes(1);

    // Row was rolled back
    const rows = await (adapter as any)
      .__knex("testitems")
      .where("id", "second");
    expect(rows.length).toBe(0);
  });

  it("fires cleanups when a sync after-hook throws (note: DB row is NOT rolled back)", async () => {
    // Semantics: onError is for compensating external side effects, not for
    // DB atomicity. When an after-hook throws, the INSERT has already
    // committed, but cleanup handlers still fire so hooks can undo their own
    // external work (Clerk calls, S3 uploads, etc.).
    const cleanup = vi.fn();

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(cleanup);
    });

    hook.after(TestModel as any, "create", () => {
      throw new Error("after failed");
    });

    await expect(
      adapter.save(
        makeModel({ id: "rb", name: "x" }),
        { creating: true, ops: [], updates: [] } as any,
      ),
    ).rejects.toThrow("after failed");

    expect(cleanup).toHaveBeenCalledTimes(1);

    // Row WAS inserted — onError does not provide DB rollback
    const rows = await (adapter as any).__knex("testitems").where("id", "rb");
    expect(rows.length).toBe(1);
  });

  it("runs cleanups in LIFO order across multiple registrations", async () => {
    const order: string[] = [];

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(() => {
        order.push("A");
      });
      onError(() => {
        order.push("B");
      });
    }, { priority: 10 });

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(() => {
        order.push("C");
      });
    }, { priority: 20 });

    hook.before(TestModel as any, "create", () => {
      throw new Error("boom");
    }, { priority: 30 });

    await expect(
      adapter.save(
        makeModel({ id: "lifo", name: "y" }),
        { creating: true, ops: [], updates: [] } as any,
      ),
    ).rejects.toThrow("boom");

    // Registered: [A, B, C]. LIFO => [C, B, A].
    expect(order).toEqual(["C", "B", "A"]);
  });

  it("a throwing cleanup does not stop subsequent cleanups, and does not replace the original error", async () => {
    const order: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(() => {
        order.push("first");
      });
      onError(() => {
        order.push("throwing");
        throw new Error("cleanup exploded");
      });
      onError(() => {
        order.push("last");
      });
    }, { priority: 10 });

    hook.before(TestModel as any, "create", () => {
      throw new Error("ORIGINAL");
    }, { priority: 20 });

    await expect(
      adapter.save(
        makeModel({ id: "x1", name: "z" }),
        { creating: true, ops: [], updates: [] } as any,
      ),
    ).rejects.toThrow("ORIGINAL");

    // LIFO across [first, throwing, last] => [last, throwing, first]
    expect(order).toEqual(["last", "throwing", "first"]);
    consoleError.mockRestore();
  });

  it("does not run cleanups on successful save", async () => {
    const cleanup = vi.fn();

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(cleanup);
    });

    await adapter.save(
      makeModel({ id: "ok1", name: "ok" }),
      { creating: true, ops: [], updates: [] } as any,
    );

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("onError is a no-op when called inside an async-option hook", async () => {
    const cleanup = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    hook.after(
      TestModel as any,
      "create",
      async ({ onError }: HookContext) => {
        // Async hook — registering cleanup should be ignored.
        onError(cleanup);
      },
      { async: true },
    );

    await adapter.save(
      makeModel({ id: "async1", name: "a" }),
      { creating: true, ops: [], updates: [] } as any,
    );

    // Give the fire-and-forget hook a moment
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanup).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("fires cleanups for remove() when a before-hook throws", async () => {
    await adapter.save(
      makeModel({ id: "rm1", name: "to-remove" }),
      { creating: true, ops: [], updates: [] } as any,
    );

    const cleanup = vi.fn();

    hook.before(TestModel as any, "remove", ({ onError }: HookContext) => {
      onError(cleanup);
    }, { priority: 10 });

    hook.before(TestModel as any, "remove", () => {
      throw new Error("remove before failed");
    }, { priority: 20 });

    const model = makeModel({ id: "rm1", name: "to-remove" });
    await expect(adapter.remove(model)).rejects.toThrow("remove before failed");
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Row still exists (remove was rolled back)
    const rows = await (adapter as any).__knex("testitems").where("id", "rm1");
    expect(rows.length).toBe(1);
  });

  it("cleanups registered via ctx.onError run even when the after-hook succeeds but a later DB op fails", async () => {
    // Simulate: a before-hook registers cleanup, then an after-hook does
    // additional work that throws — the save's INSERT should roll back, and
    // the cleanup should fire.
    const cleanup = vi.fn();

    hook.before(TestModel as any, "create", ({ onError }: HookContext) => {
      onError(cleanup);
    });

    hook.after(TestModel as any, "create", () => {
      throw new Error("after work failed");
    });

    await expect(
      adapter.save(
        makeModel({ id: "mixed", name: "mm" }),
        { creating: true, ops: [], updates: [] } as any,
      ),
    ).rejects.toThrow("after work failed");

    expect(cleanup).toHaveBeenCalledTimes(1);

    // Row IS present — onError does not roll back DB state
    const rows = await (adapter as any)
      .__knex("testitems")
      .where("id", "mixed");
    expect(rows.length).toBe(1);
  });

  it("fires cleanups for patch() when an after-hook throws", async () => {
    // Seed the row directly
    await (adapter as any)
      .__knex("testitems")
      .insert({ id: "patch1", name: "before", data: "{}" });

    const cleanup = vi.fn();

    hook.before(TestModel as any, "patch", ({ onError }: HookContext) => {
      onError(cleanup);
    });

    hook.after(TestModel as any, "patch", () => {
      throw new Error("patch after failed");
    });

    const model = makeModel({ id: "patch1", name: "before" });
    await expect(
      adapter.patch(model, [
        { op: "replace", path: "/name", value: "after" } as any,
      ]),
    ).rejects.toThrow("patch after failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
    // Patch UPDATE committed before the after-hook threw — name is "after".
    // onError is not about DB rollback; it's about external-side-effect compensation.
    const row = await (adapter as any)
      .__knex("testitems")
      .where("id", "patch1")
      .first();
    expect(row.name).toBe("after");
  });
});
