/**
 * Regression test: `Model.whereIn(arrayCol, [v]).find()` on the server
 * side must dispatch through `_applyJsonArrayWhereIn` exactly the way
 * `queryFromClient` does for client-sent steps.
 *
 * Without this dispatch, a server-side controller calling
 * `Post.whereIn("performers", [id]).find()` falls through to bare
 * `WHERE "performers" IN (?)` and Postgres errors with
 * `invalid input syntax for type json` — the JSONB column can't be
 * compared to a raw string token.
 */
import { describe, it, expect } from "vitest";

import { BackendAdapter } from "../adapters/model";
import type { SchemaDefinition } from "@parcae/model";

// A real class so `new ModelClass()` works — `_isJsonArrayColumn`
// probes the runtime default to distinguish array vs object json columns.
class PostArrayModel {
  static type = "post_array";
  static __schema: SchemaDefinition = {
    name: "string",
    performers: "json",
    studios: "json",
    metadata: "json",
  };
  name = "";
  performers: string[] = []; // ← array default
  studios: string[] = []; // ← array default
  metadata: any = null; // ← object/any default
}

/** Build a recording knex stand-in: every method call is captured and
 *  returns the same proxy so chains compose. */
function recordingChain() {
  const calls: Array<{ method: string; args: any[] }> = [];
  const make = (): any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "find") return async () => [];
          if (prop === "first") return async () => null;
          if (prop === "count") return async () => 0;
          if (prop === "exec") return () => ({});
          if (prop === "clone") return () => make();
          if (prop === "then") return undefined; // not a thenable
          return (...args: any[]) => {
            calls.push({ method: prop, args });
            return make();
          };
        },
      },
    );
  return { calls, chain: make() };
}

function createTestAdapter() {
  const { calls, chain } = recordingChain();
  const adapter = new (BackendAdapter as any)({
    read: () => chain,
    write: () => chain,
  });
  return { adapter: adapter as BackendAdapter, calls };
}

describe("BackendAdapter.query() — server-side whereIn on JSON-array columns", () => {
  it("Postgres: dispatches whereIn(arrayCol, vals) to @> containment SQL", () => {
    const { adapter, calls } = createTestAdapter();
    (adapter as any).engine = "postgres";

    adapter.query(PostArrayModel as any).whereIn("performers", ["p1", "p2"]);

    const whereRaw = calls.find((c) => c.method === "whereRaw");
    expect(whereRaw).toBeDefined();
    expect(whereRaw!.args[0]).toContain("@>");
    expect((whereRaw!.args[0].match(/@>/g) ?? []).length).toBe(2);
    expect(whereRaw!.args[1]).toEqual([
      "performers",
      '["p1"]',
      "performers",
      '["p2"]',
    ]);

    // The native whereIn — which would produce the broken `IN (?)` SQL
    // — must NOT have been called.
    const nativeWhereIn = calls.find(
      (c) => c.method === "whereIn" && c.args[0] === "performers",
    );
    expect(nativeWhereIn).toBeUndefined();
  });

  it("SQLite: dispatches whereIn(arrayCol, vals) to LIKE containment SQL", () => {
    const { adapter, calls } = createTestAdapter();
    (adapter as any).engine = "sqlite";

    adapter.query(PostArrayModel as any).whereIn("studios", ["s1"]);

    const whereRaw = calls.find((c) => c.method === "whereRaw");
    expect(whereRaw).toBeDefined();
    expect(whereRaw!.args[0]).toContain("LIKE");
    expect(whereRaw!.args[1]).toEqual(["studios", '%"s1"%']);
  });

  it("falls through to native whereIn for scalar columns", () => {
    const { adapter, calls } = createTestAdapter();
    (adapter as any).engine = "postgres";

    adapter.query(PostArrayModel as any).whereIn("name", ["a", "b"]);

    const whereInCall = calls.find(
      (c) => c.method === "whereIn" && c.args[0] === "name",
    );
    expect(whereInCall).toBeDefined();
    expect(whereInCall!.args).toEqual(["name", ["a", "b"]]);
    expect(calls.find((c) => c.method === "whereRaw")).toBeUndefined();
  });

  it("dispatches to @> for any json column (schema-only — no array probe)", () => {
    const { adapter, calls } = createTestAdapter();
    (adapter as any).engine = "postgres";

    // `metadata` schema is `"json"` even though its runtime default is
    // `null`. We dispatch on schema alone now; whereIn-against-an-
    // object is the caller's responsibility to avoid.
    adapter.query(PostArrayModel as any).whereIn("metadata", ["x"]);

    const whereRaw = calls.find((c) => c.method === "whereRaw");
    expect(whereRaw).toBeDefined();
    expect(whereRaw!.args[0]).toContain("@>");
  });

  it("emits 1=0 for an empty values array", () => {
    const { adapter, calls } = createTestAdapter();
    (adapter as any).engine = "postgres";

    adapter.query(PostArrayModel as any).whereIn("performers", []);

    const whereRaw = calls.find((c) => c.method === "whereRaw");
    expect(whereRaw).toBeDefined();
    expect(whereRaw!.args[0]).toBe("1 = 0");
  });
});
