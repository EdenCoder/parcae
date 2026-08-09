/**
 * Per-row locking on the auto-CRUD PUT path.
 *
 * PUT is a read-modify-write of a whole row: it reads the current
 * record, mass-assigns the request body over it, and saves the merged
 * result. Two PUTs to the same row that interleave between the read
 * and the save each write a merge built from a stale snapshot, so the
 * later writer silently reverts fields the earlier one changed. The
 * route serialises on `lockRow(type, id)` to close that window.
 *
 * PATCH is deliberately not covered here — it issues a column-subset
 * UPDATE and never round-trips the whole row, so it has no window to
 * close.
 *
 * The in-process AsyncLock fallback (no REDIS_URL) is a real lock, so
 * the serialisation test below is honest without Redis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { clearRoutes, getRoutes } from "../routing/route";
import { registerModelRoutes } from "../adapters/routes";
import { PubSub } from "../services/pubsub";
import { _setServices, _clearServices, lockRow } from "../services/context";
import type { BackendAdapter } from "../adapters/model";

// ─── Test model ─────────────────────────────────────────────────────────────

function makePost(): any {
  return {
    type: "post",
    scope: {
      read: () => () => {},
      update: () => () => {},
    },
    readonlyFields: [] as readonly string[],
  };
}

// ─── Adapter stub ─────────────────────────────────────────────────────────

/**
 * Minimal adapter the PUT route can drive. `saveGate` lets a test hold
 * a request open inside `save()` so a second request has something to
 * contend with.
 */
function makeAdapterStub() {
  const events: string[] = [];
  let nextRow: Record<string, any> | null = { id: "p1", title: "old" };
  let saveGate: Promise<void> | null = null;

  const adapter: any = {
    async runInTransaction(fn: () => Promise<any>) {
      return await fn();
    },
    query() {
      const chain: any = {
        select: () => chain,
        where: () => chain,
        exec: () => ({ forUpdate: () => {} }),
        first: async () => {
          events.push("read");
          return nextRow ? buildRow(nextRow) : null;
        },
        find: async () => (nextRow ? [buildRow(nextRow)] : []),
        count: async () => (nextRow ? 1 : 0),
      };
      return chain;
    },
    queryFromClient() {
      const chain: any = { find: async () => [], count: async () => 0 };
      return chain;
    },
    patch: vi.fn(),
    subscriptions: null,
  };

  function buildRow(row: Record<string, any>) {
    return {
      ...row,
      save: vi.fn(async function (this: any) {
        events.push("save:start");
        if (saveGate) await saveGate;
        events.push("save:end");
      }),
      patch: vi.fn(async function (this: any, ops: any[]) {
        events.push("patch");
        for (const op of ops) {
          if (op.op !== "add" && op.op !== "replace") continue;
          const field = op.path.slice(1);
          this[field] = op.value;
          this.__data[field] = op.value;
        }
      }),
      sanitize: undefined,
      __data: row,
    };
  }

  return {
    adapter: adapter as BackendAdapter,
    events,
    setRow(row: Record<string, any> | null) {
      nextRow = row;
    },
    setSaveGate(gate: Promise<void> | null) {
      saveGate = gate;
    },
  };
}

// ─── Lock harness ─────────────────────────────────────────────────────────

/**
 * Installs a real (Redis-less) PubSub as the process's service context
 * and records every key/ttl the route locks on, plus every release.
 */
function installPubSub() {
  const pubsub = new PubSub();
  const acquired: Array<{ key: string; ttl?: number }> = [];
  const released: string[] = [];
  const real = pubsub.lock.bind(pubsub);

  vi.spyOn(pubsub, "lock").mockImplementation(async (key, ttl) => {
    acquired.push({ key, ttl });
    const unlock = await real(key, ttl);
    return async () => {
      released.push(key);
      await unlock();
    };
  });

  _setServices(null as any, pubsub);
  return { acquired, released };
}

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

describe("lockRow", () => {
  afterEach(() => {
    _clearServices();
    vi.restoreAllMocks();
  });

  it("namespaces the key by type and id", async () => {
    const { acquired, released } = installPubSub();

    const unlock = await lockRow("post", "p1");
    await unlock();

    // No explicit ttl — `lock`'s own default applies.
    expect(acquired).toEqual([{ key: "row:post:p1", ttl: 120_000 }]);
    expect(released).toEqual(["row:post:p1"]);
  });

  it("passes an explicit ttl straight through", async () => {
    const { acquired } = installPubSub();

    const unlock = await lockRow("event", "e9", 10_000);
    await unlock();

    expect(acquired[0]).toEqual({ key: "row:event:e9", ttl: 10_000 });
  });
});

describe("auto-CRUD PUT row lock", () => {
  beforeEach(() => {
    clearRoutes();
  });

  afterEach(() => {
    _clearServices();
    vi.restoreAllMocks();
  });

  it("acquires and releases the row lock on a successful update", async () => {
    const { acquired, released } = installPubSub();
    const fixture = makeAdapterStub();
    fixture.setRow({ id: "p1", title: "old" });
    registerModelRoutes([makePost()], fixture.adapter);

    const res = makeRes();
    await findRoute("PUT", "/v1/posts/:id")!.handler!(
      { params: { id: "p1" }, body: { title: "new" } },
      res as any,
    );

    expect(res.captured.status).toBe(200);
    expect(acquired).toEqual([{ key: "row:post:p1", ttl: 10_000 }]);
    expect(released).toEqual(["row:post:p1"]);
  });

  it("releases the row lock when the row is not found", async () => {
    const { acquired, released } = installPubSub();
    const fixture = makeAdapterStub();
    fixture.setRow(null);
    registerModelRoutes([makePost()], fixture.adapter);

    const res = makeRes();
    await findRoute("PUT", "/v1/posts/:id")!.handler!(
      { params: { id: "p1" }, body: { title: "new" } },
      res as any,
    );

    expect(res.captured.status).toBe(404);
    expect(acquired).toEqual([{ key: "row:post:p1", ttl: 10_000 }]);
    expect(released).toEqual(["row:post:p1"]);
  });

  it("serialises two overlapping PUTs to the same row", async () => {
    installPubSub();
    const fixture = makeAdapterStub();
    fixture.setRow({ id: "p1", title: "old" });

    let openTheGate!: () => void;
    fixture.setSaveGate(
      new Promise<void>((resolve) => {
        openTheGate = resolve;
      }),
    );
    registerModelRoutes([makePost()], fixture.adapter);

    const route = findRoute("PUT", "/v1/posts/:id")!;
    const first = route.handler!(
      { params: { id: "p1" }, body: { title: "first" } },
      makeRes() as any,
    );
    await new Promise((r) => setTimeout(r, 10));

    const second = route.handler!(
      { params: { id: "p1" }, body: { title: "second" } },
      makeRes() as any,
    );
    await new Promise((r) => setTimeout(r, 10));

    // The second request must not have read the row yet — reading it
    // now is exactly the stale snapshot the lock exists to prevent.
    expect(fixture.events).toEqual(["read", "save:start"]);

    openTheGate();
    await Promise.all([first, second]);

    expect(fixture.events).toEqual([
      "read",
      "save:start",
      "save:end",
      "read",
      "save:start",
      "save:end",
    ]);
  });

  it("does not lock on PATCH", async () => {
    const { acquired } = installPubSub();
    const fixture = makeAdapterStub();
    fixture.setRow({ id: "p1", title: "old" });
    const Post = makePost();
    Post.scope.patch = () => () => {};
    registerModelRoutes([Post], fixture.adapter);

    const res = makeRes();
    await findRoute("PATCH", "/v1/posts/:id")!.handler!(
      {
        params: { id: "p1" },
        body: { ops: [{ op: "replace", path: "/title", value: "new" }] },
      },
      res as any,
    );

    expect(acquired).toEqual([]);
  });
});
