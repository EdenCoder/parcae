/**
 * Field-level write protection in auto-CRUD routes.
 *
 * The framework hardcodes `id` / `createdAt` / `updatedAt` / `type` as
 * server-controlled; per-model `static readonlyFields` adds counter
 * columns, ownership refs, state-machine cols. The auto-CRUD routes
 * strip those fields from incoming POST / PUT bodies and reject PATCH
 * ops that target them.
 *
 * These tests exercise the boundary at the route shim (without booting
 * a real DB) — they assert the strip / reject behavior happens BEFORE
 * `Model.create` / `model.save` / `model.patch` is called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { clearRoutes, getRoutes } from "../routing/route";
import { registerModelRoutes } from "../adapters/routes";
import type { BackendAdapter } from "../adapters/model";

// ─── Test model ─────────────────────────────────────────────────────────────

/**
 * Plain model-class shape. We don't extend the real `Model` so the test
 * stays focused on the route shim's behavior — `Model.create.call(...)`
 * is monkey-patched per-test via the adapter's `query()` stub.
 */
function makePost(): any {
  const Post: any = {
    type: "post",
    scope: {
      // Trivial scopes — every request gets through to the strip/reject
      // logic. Returning `() => {}` for read/update/delete is the
      // "anyone can do anything (subject to body filters)" shape.
      read: () => () => {},
      create: (ctx: any) => ({ user: ctx.user?.id ?? "scope-user" }),
      update: () => () => {},
      patch: () => () => {},
    },
    // Server-managed columns + the scope-owning ref. A client that
    // tries to bump `viewCount` or reassign `user` via HTTP should be
    // ignored by POST/PUT and rejected by PATCH.
    readonlyFields: ["viewCount", "user"] as readonly string[],
  };
  return Post;
}

// ─── Adapter stub ─────────────────────────────────────────────────────────

/**
 * Captures the values that reach the framework so tests can assert on
 * them. Stubs every adapter method the routes touch.
 */
function makeAdapterStub() {
  const captured: {
    saves: Array<Record<string, any>>;
    patches: Array<{ ops: any[] }>;
    instances: Array<Record<string, any>>;
    lockStates: boolean[];
    saveStates: boolean[];
  } = {
    saves: [],
    patches: [],
    instances: [],
    lockStates: [],
    saveStates: [],
  };

  let nextRow: Record<string, any> | null = { id: "p1", title: "old" };
  let isTransactionActive = false;
  let saveGate: Promise<void> | null = null;

  const adapter: any = {
    isSqlite: false,
    async runInTransaction(fn: () => Promise<any>) {
      isTransactionActive = true;
      try {
        return await fn();
      } finally {
        isTransactionActive = false;
      }
    },
    query() {
      // Chain that always resolves to `nextRow`.
      const chain: any = {
        select: () => chain,
        where: () => chain,
        exec: () => ({
          forUpdate: () => {
            captured.lockStates.push(isTransactionActive);
          },
        }),
        first: async () => nextRow,
        find: async () => (nextRow ? [nextRow] : []),
        count: async () => (nextRow ? 1 : 0),
      };
      return chain;
    },
    queryFromClient() {
      const chain: any = {
        find: async () => [],
        count: async () => 0,
      };
      return chain;
    },
    patch: vi.fn(async () => {
      throw new Error("route must use Model.patch");
    }),
    subscriptions: null,
  };

  return {
    adapter: adapter as BackendAdapter,
    captured,
    setRow(row: Record<string, any> | null) {
      nextRow = row
        ? {
            ...row,
            save: vi.fn(async function (this: any) {
              captured.saveStates.push(isTransactionActive);
              if (saveGate) await saveGate;
              captured.saves.push({ ...this });
            }),
            patch: vi.fn(async function (this: any, ops: any[]) {
              captured.patches.push({ ops });
              captured.instances.push(this);
              for (const op of ops) {
                if (op.op !== "add" && op.op !== "replace") continue;
                const field = op.path.slice(1);
                this[field] = op.value;
                this.__data[field] = op.value;
              }
            }),
            sanitize: undefined,
            __data: row,
          }
        : null;
    },
    setSaveGate(gate: Promise<void> | null) {
      saveGate = gate;
    },
    isTransactionActive() {
      return isTransactionActive;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findRoute(method: string, path: string) {
  return getRoutes().find((r) => r.method === method && r.path === path);
}

function makeRes() {
  const captured: { status?: number; body?: any } = {};
  return {
    captured,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(body: string) {
      try {
        captured.body = JSON.parse(body);
      } catch {
        captured.body = body;
      }
      return this;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("auto-CRUD readonlyFields", () => {
  beforeEach(() => {
    clearRoutes();
  });

  // POST stripping is exercised indirectly through `stripReadonly`
  // (same helper used by PUT below) — a focused unit test would have
  // to boot the real `Model` class, which isn't worth it for a one-
  // liner helper. The PUT and PATCH tests below are the contract
  // ones; both routes share the same `stripReadonly` / `readonlyFor`
  // primitives.

  it("PUT strips readonly fields from the body before save", async () => {
    const Post = makePost();
    const { adapter, captured, setRow } = makeAdapterStub();
    setRow({ id: "p1", title: "old", viewCount: 5, user: "u-original" });
    registerModelRoutes([Post], adapter);

    const route = findRoute("PUT", "/v1/posts/:id");
    expect(route).toBeDefined();

    const res = makeRes();
    await route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: {
          title: "new title",
          viewCount: 9999, // readonly counter — should be ignored
          user: "u-attacker", // readonly ownership ref — should be ignored
          $user: "u-dollar-attacker", // raw-id companions are never writable
          createdAt: new Date(0), // system field — should be ignored
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(200);
    expect(captured.saves).toHaveLength(1);
    const saved = captured.saves[0]!;
    expect(saved.title).toBe("new title");
    expect(saved.viewCount).toBe(5); // unchanged from original
    expect(saved.user).toBe("u-original"); // unchanged from original
    expect(saved.$user).toBeUndefined();
  });

  it("PATCH rejects ops targeting readonly columns with 403", async () => {
    const Post = makePost();
    const { adapter, captured, setRow } = makeAdapterStub();
    setRow({ id: "p1", title: "old", viewCount: 5 });
    registerModelRoutes([Post], adapter);

    const route = findRoute("PATCH", "/v1/posts/:id");
    expect(route).toBeDefined();

    const res = makeRes();
    await route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: {
          ops: [
            { op: "replace", path: "/title", value: "ok" },
            { op: "replace", path: "/viewCount", value: 9999 }, // readonly
          ],
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(403);
    expect(res.captured.body.error).toContain("viewCount");
    // Even though the title op is fine, the whole batch is rejected
    // — fail-loud is the desired contract.
    expect(captured.patches).toHaveLength(0);
  });

  it("PATCH rejects raw ref companion ops with 403", async () => {
    const Post = makePost();
    const { adapter, captured, setRow } = makeAdapterStub();
    setRow({ id: "p1", title: "old", user: "u-original" });
    registerModelRoutes([Post], adapter);

    const route = findRoute("PATCH", "/v1/posts/:id");
    const res = makeRes();
    await route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: {
          ops: [{ op: "replace", path: "/$user", value: "u-attacker" }],
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(403);
    expect(res.captured.body.error).toContain("$user");
    expect(captured.patches).toHaveLength(0);
  });

  it("PATCH allows ops on writable columns", async () => {
    const Post = makePost();
    const { adapter, captured, setRow } = makeAdapterStub();
    setRow({ id: "p1", title: "old" });
    registerModelRoutes([Post], adapter);

    const route = findRoute("PATCH", "/v1/posts/:id");

    const res = makeRes();
    await route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: {
          ops: [{ op: "replace", path: "/title", value: "new" }],
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(200);
    expect(captured.patches).toHaveLength(1);
    expect(captured.patches[0]!.ops).toHaveLength(1);
    expect(res.captured.body.result.title).toBe("new");
    expect((adapter.patch as any).mock.calls).toHaveLength(0);
  });

  it.each(["copy", "move"])(
    "PATCH rejects unsupported %s before reading the row",
    async (operation) => {
      const Post = makePost();
      const { adapter, captured, setRow } = makeAdapterStub();
      setRow({
        id: "p1",
        title: "public",
        secret: "must-not-copy",
      });
      registerModelRoutes([Post], adapter);

      const route = findRoute("PATCH", "/v1/posts/:id");
      const res = makeRes();
      await route!.handler!(
        {
          params: { id: "p1" },
          body: {
            ops: [
              {
                op: operation,
                from: "/secret",
                path: "/title",
              },
            ],
          },
        },
        res as any,
      );

      expect(res.captured.status).toBe(400);
      expect(res.captured.body.error).toContain(`unsupported op \"${operation}\"`);
      expect(captured.lockStates).toHaveLength(0);
      expect(captured.patches).toHaveLength(0);
    },
  );

  it("keeps scoped lookup, row lock, and PUT save in one transaction", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const Post = makePost();
    const fixture = makeAdapterStub();
    fixture.setRow({ id: "p1", title: "old", user: "u1" });
    fixture.setSaveGate(gate);
    registerModelRoutes([Post], fixture.adapter);

    const route = findRoute("PUT", "/v1/posts/:id");
    const response = route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: { title: "new" },
      },
      makeRes() as any,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.captured.lockStates).toEqual([true]);
    expect(fixture.captured.saveStates).toEqual([true]);
    expect(fixture.isTransactionActive()).toBe(true);

    release();
    await response;
    expect(fixture.isTransactionActive()).toBe(false);
  });

  it("PATCH rejects system fields (id/createdAt/updatedAt/type) by default", async () => {
    // Model with NO custom readonlyFields — only the framework defaults
    // apply.
    const PlainPost: any = {
      type: "plainpost",
      scope: {
        patch: () => () => {},
      },
      readonlyFields: [] as readonly string[],
    };
    const { adapter, captured, setRow } = makeAdapterStub();
    setRow({ id: "p1", title: "old" });
    registerModelRoutes([PlainPost], adapter);

    const route = findRoute("PATCH", "/v1/plainposts/:id");

    const res = makeRes();
    await route!.handler!(
      {
        session: { user: { id: "u1" } },
        params: { id: "p1" },
        body: {
          ops: [{ op: "replace", path: "/createdAt", value: new Date(0) }],
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(403);
    expect(res.captured.body.error).toContain("createdAt");
    expect(captured.patches).toHaveLength(0);
  });
});
