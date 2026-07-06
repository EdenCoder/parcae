/**
 * `prepareClientQuery` must force `id` into client select projections.
 *
 * Rows hydrated without their id get a FRESH generated one per read
 * (the Model constructor falls back to `generateId()`), so a client
 * that fetched `select("project", "user")` and later calls
 * `row.remove()` targets a phantom id the DB never stored — a 404 that
 * looks like data corruption. Cost a full on-device debugging session
 * in the Lynx app before it was traced here.
 */

import { describe, expect, it } from "vitest";
import { BackendAdapter } from "../adapters/model";
import { prepareClientQuery } from "../services/query-subscription";

function createTestAdapter() {
  const calls: Array<{ method: string; args: any[] }> = [];

  function makeChain(): any {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "find") return async () => [];
          if (prop === "first") return async () => null;
          if (prop === "count") return async () => 0;
          if (prop === "exec") return () => ({});
          if (prop === "clone") return () => makeChain();
          return (...args: any[]) => {
            calls[calls.length] = { method: prop, args };
            return makeChain();
          };
        },
      },
    );
  }

  const adapter = new (BackendAdapter as any)({
    read: () => {},
    write: () => {},
  });
  adapter.query = () => makeChain();

  return { adapter: adapter as BackendAdapter, calls };
}

const ListModel = {
  type: "list",
  __schema: { user: "string", project: "string" },
} as any;

function prepare(steps: unknown) {
  const { adapter, calls } = createTestAdapter();
  prepareClientQuery({
    ModelClass: ListModel,
    scopeResult: { user: "u1" },
    rawSteps: steps,
    modelByType: new Map([["list", ListModel]]),
    adapter,
  });
  return calls;
}

describe("prepareClientQuery select-id projection", () => {
  it("prepends id to a select that omits it", () => {
    const calls = prepare([{ method: "select", args: ["project", "user"] }]);
    const select = calls.find((c) => c.method === "select");
    expect(select?.args).toEqual(["id", "project", "user"]);
  });

  it("leaves a select that already includes id untouched", () => {
    const calls = prepare([{ method: "select", args: ["id", "project"] }]);
    const select = calls.find((c) => c.method === "select");
    expect(select?.args).toEqual(["id", "project"]);
  });

  it("handles array-form select args", () => {
    const calls = prepare([{ method: "select", args: [["project", "user"]] }]);
    const select = calls.find((c) => c.method === "select");
    expect(select?.args).toEqual(["id", "project", "user"]);
  });

  it("does not fabricate a select step when the client sent none", () => {
    const calls = prepare([{ method: "where", args: [{ project: "p1" }] }]);
    expect(calls.find((c) => c.method === "select")).toBeUndefined();
  });
});
