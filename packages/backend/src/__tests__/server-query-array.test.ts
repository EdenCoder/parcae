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

import type { SchemaDefinition } from "@parcae/model";
// Value import — the aggregate tests below hand-build a chain that
// returns real values, which the recording proxy can't stand in for.
import { BackendAdapter } from "../adapters/model";
import { createTestAdapter } from "./adapter-test";

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

// `realQuery` leaves `adapter.query()` intact so the server-side path
// under test actually runs; `read`/`write` still feed the recording
// chain, so the emitted calls are captured either way.
const testAdapter = () => createTestAdapter({ realQuery: true });

describe("BackendAdapter.query() — server-side whereIn on JSON-array columns", () => {
  it("Postgres: dispatches whereIn(arrayCol, vals) to @> containment SQL", () => {
    const { adapter, calls } = testAdapter();
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

  it("falls through to native whereIn for scalar columns", () => {
    const { adapter, calls } = testAdapter();
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
    const { adapter, calls } = testAdapter();
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
    const { adapter, calls } = testAdapter();
    (adapter as any).engine = "postgres";

    adapter.query(PostArrayModel as any).whereIn("performers", []);

    const whereRaw = calls.find((c) => c.method === "whereRaw");
    expect(whereRaw).toBeDefined();
    expect(whereRaw!.args[0]).toBe("1 = 0");
  });
});

describe("BackendAdapter.query() — aggregate terminals", () => {
  it("maps clearLimit() to Knex clear('limit')", () => {
    const { adapter, calls } = testAdapter();

    adapter.query(PostArrayModel as any).limit(10).clearLimit();

    expect(calls).toContainEqual({ method: "limit", args: [10] });
    expect(calls).toContainEqual({ method: "clear", args: ["limit"] });
    expect(calls.some((call) => call.method === "clearLimit")).toBe(false);
  });

  it("count() clears limit and offset before aggregating", async () => {
    const cleared: string[] = [];
    const chain: any = {
      limit: () => chain,
      offset: () => chain,
      clone: () => chain,
      clearSelect: () => chain,
      clearOrder: () => chain,
      clear: (statement: string) => {
        cleared.push(statement);
        return chain;
      },
      count: async () => [{ total: "4" }],
    };
    const adapter = new BackendAdapter({
      read: () => chain,
      write: () => chain,
    });

    await expect(
      adapter.query(PostArrayModel as any).limit(1).offset(3).count(),
    ).resolves.toBe(4);
    expect(cleared).toEqual(["limit", "offset"]);
  });

  it("sum() returns a numeric scalar from the scoped query", async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const chain: any = {
      where: (...args: any[]) => {
        calls.push({ method: "where", args });
        return chain;
      },
      clone: () => chain,
      clearSelect: () => {
        calls.push({ method: "clearSelect", args: [] });
        return chain;
      },
      clearOrder: () => {
        calls.push({ method: "clearOrder", args: [] });
        return chain;
      },
      clear: (statement: string) => {
        calls.push({ method: "clear", args: [statement] });
        return chain;
      },
      sum: async (...args: any[]) => {
        calls.push({ method: "sum", args });
        return [{ total: "12" }];
      },
    };
    const adapter = new (BackendAdapter as any)({
      read: () => chain,
      write: () => chain,
    }) as BackendAdapter;

    await expect(
      adapter.query(PostArrayModel as any).where({ name: "paid" }).sum("views"),
    ).resolves.toBe(12);

    expect(calls).toEqual([
      { method: "where", args: [{ name: "paid" }] },
      { method: "clearSelect", args: [] },
      { method: "clearOrder", args: [] },
      { method: "clear", args: ["limit"] },
      { method: "clear", args: ["offset"] },
      { method: "sum", args: [{ total: "views" }] },
    ]);
  });
});
