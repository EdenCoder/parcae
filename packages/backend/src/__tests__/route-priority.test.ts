/**
 * Auto-CRUD routes must not shadow user-registered custom routes.
 *
 * The framework auto-generates `GET /{path}/:id` (and friends) for
 * every model with a `scope.read`. A user controller registering
 * `GET /{path}/literal` MUST win the match, otherwise `literal` gets
 * parsed as an id, `findByIdOrTmp` returns null, and the request 404s
 * with `"{type} not found"` — a confusing failure mode whose root cause
 * is invisible at the call site.
 *
 * The fix: auto-CRUD routes register at `priority: 200`; user routes
 * default to `priority: 100`. `getRoutes()` already sorts ascending,
 * and the app attaches routes to polka in that order, so user routes
 * land first and polka (registration-order-first-match) picks them.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { clearRoutes, getRoutes, route } from "../routing/route";
import { registerModelRoutes } from "../adapters/routes";
import type { BackendAdapter } from "../adapters/model";

/**
 * Minimal model that supports auto-CRUD GET-by-id. We don't need a
 * real `Model` subclass — the route shim only reads `type`, `scope`,
 * and `readonlyFields` off the constructor surface.
 */
function makeSource(): any {
  return {
    type: "source",
    scope: { read: () => () => {} },
    readonlyFields: [] as readonly string[],
  };
}

/**
 * Stubs the adapter calls the GET-one handler makes so the test runs
 * without a real DB. We don't care about the adapter's result — only
 * about which handler polka would dispatch to.
 */
function makeAdapterStub(): BackendAdapter {
  const adapter: any = {
    query() {
      const chain: any = {
        select: () => chain,
        where: () => chain,
        first: async () => null,
        find: async () => [],
      };
      return chain;
    },
    subscriptions: null,
  };
  return adapter as BackendAdapter;
}

describe("route priority — custom routes shadow auto-CRUD", () => {
  beforeEach(() => {
    clearRoutes();
  });

  it("user-registered /{path}/literal sorts before auto-CRUD /{path}/:id", () => {
    // Order mirrors the app boot: register auto-CRUD FIRST (step 12),
    // then user controllers (step 13). The sort in `getRoutes()` is
    // what guarantees the literal route wins — not registration order.
    registerModelRoutes([makeSource()], makeAdapterStub());
    route.get("/v1/sources/providers", (_req: any, res: any) => {
      res.writeHead(200);
      res.end("{}");
    });

    const sorted = getRoutes();
    const literal = sorted.findIndex(
      (r) => r.method === "GET" && r.path === "/v1/sources/providers",
    );
    const param = sorted.findIndex(
      (r) => r.method === "GET" && r.path === "/v1/sources/:id",
    );

    expect(literal).toBeGreaterThanOrEqual(0);
    expect(param).toBeGreaterThanOrEqual(0);
    expect(literal).toBeLessThan(param);
  });

  it("auto-CRUD routes default to a lower priority than user routes", () => {
    registerModelRoutes([makeSource()], makeAdapterStub());
    route.get("/v1/sources/providers", (_req: any, res: any) => {
      res.writeHead(200);
      res.end("{}");
    });

    const all = getRoutes();
    const auto = all.find(
      (r) => r.method === "GET" && r.path === "/v1/sources/:id",
    );
    const user = all.find(
      (r) => r.method === "GET" && r.path === "/v1/sources/providers",
    );

    expect(auto).toBeDefined();
    expect(user).toBeDefined();
    // Lower number = higher precedence in `getRoutes()`'s ascending sort.
    expect(user!.priority).toBeLessThan(auto!.priority);
  });

  it("respects an explicit user-supplied priority that overrides the auto-CRUD floor", () => {
    // A user who deliberately sets a higher priority number than
    // auto-CRUD (e.g. for a generic catch-all that should run last)
    // keeps that ordering. The fix only changes the DEFAULT — explicit
    // priorities still win.
    registerModelRoutes([makeSource()], makeAdapterStub());
    route.get(
      "/v1/sources/_catchall",
      (_req: any, res: any) => {
        res.writeHead(200);
        res.end("{}");
      },
      { priority: 500 },
    );

    const all = getRoutes();
    const auto = all.find(
      (r) => r.method === "GET" && r.path === "/v1/sources/:id",
    );
    const userCatchall = all.find(
      (r) => r.method === "GET" && r.path === "/v1/sources/_catchall",
    );

    expect(auto).toBeDefined();
    expect(userCatchall).toBeDefined();
    expect(auto!.priority).toBeLessThan(userCatchall!.priority);
  });

  it("auto-CRUD routes for the same model still respect each other's order", () => {
    // Sanity: bumping all auto-CRUD priorities by the same constant
    // shouldn't change the relative order of LIST / GET-one / POST /
    // PUT / DELETE / PATCH within a single model.
    registerModelRoutes([makeSource()], makeAdapterStub());

    const auto = getRoutes().filter((r) => r.path.startsWith("/v1/sources"));
    expect(auto.length).toBeGreaterThan(1);

    // Every auto-CRUD route shares the same priority bucket — they're
    // all `> userDefault` but equal to each other, so the sort is
    // stable on insertion order within the bucket.
    const priorities = new Set(auto.map((r) => r.priority));
    expect(priorities.size).toBe(1);
  });
});
