/**
 * Tests for dot-notation ref subquery rewriting.
 *
 * Verifies that queries like Result.whereIn("test.category", [...])
 * are rewritten into subqueries against the referenced model's table.
 *
 * Uses a real SQLite database to verify the SQL executes correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import knex from "knex";
import { Model } from "@parcae/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { BackendAdapter } from "../packages/backend/src/adapters/model";

// ─── Mock models ─────────────────────────────────────────────────────────────

class Test extends Model {
  static type = "test" as const;
  category: string = "";
  name: string = "";
  status: string = "";
}

class Result extends Model {
  static type = "result" as const;
  test!: Test;
  score: number = 0;
  passed: boolean = false;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let db: ReturnType<typeof knex>;
let adapter: BackendAdapter;
let adapterNoRegistry: BackendAdapter;

const testSchema: SchemaDefinition = {
  category: "string",
  name: "string",
  status: "string",
};

const resultSchema: SchemaDefinition = {
  test: { kind: "ref", target: Test },
  score: "number",
  passed: "boolean",
};

beforeAll(async () => {
  db = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });

  // Inject schemas onto model constructors (same as generateSchemas does)
  (Test as any).__schema = testSchema;
  (Result as any).__schema = resultSchema;

  adapter = new BackendAdapter({ read: db, write: db });
  adapter.engine = "sqlite";
  adapter.registerModels([Test, Result] as unknown as ModelConstructor[]);
  Model.use(adapter);

  // A second adapter without registerModels — simulates missing registry
  adapterNoRegistry = new BackendAdapter({ read: db, write: db });
  adapterNoRegistry.engine = "sqlite";

  // Create tables
  await db.schema.createTable("tests", (t) => {
    t.string("id").primary();
    t.text("data");
    t.dateTime("createdAt");
    t.dateTime("updatedAt");
    t.string("category", 2048);
    t.string("name", 2048);
    t.string("status", 2048);
  });

  await db.schema.createTable("results", (t) => {
    t.string("id").primary();
    t.text("data");
    t.dateTime("createdAt");
    t.dateTime("updatedAt");
    t.string("test", 2048);
    t.float("score");
    t.boolean("passed");
  });

  // Seed data
  const now = new Date().toISOString();
  await db("tests").insert([
    { id: "t1", category: "biometric", name: "Heart Rate", status: "active", data: "{}", createdAt: now, updatedAt: now },
    { id: "t2", category: "wearable", name: "Step Count", status: "active", data: "{}", createdAt: now, updatedAt: now },
    { id: "t3", category: "fitness", name: "VO2 Max", status: "active", data: "{}", createdAt: now, updatedAt: now },
    { id: "t4", category: "cognitive", name: "Reaction Time", status: "archived", data: "{}", createdAt: now, updatedAt: now },
    { id: "t5", category: "biometric", name: "Blood Pressure", status: "archived", data: "{}", createdAt: now, updatedAt: now },
  ]);

  await db("results").insert([
    { id: "r1", test: "t1", score: 72, passed: true, data: "{}", createdAt: now, updatedAt: now },
    { id: "r2", test: "t2", score: 8500, passed: true, data: "{}", createdAt: now, updatedAt: now },
    { id: "r3", test: "t3", score: 45, passed: true, data: "{}", createdAt: now, updatedAt: now },
    { id: "r4", test: "t4", score: 300, passed: false, data: "{}", createdAt: now, updatedAt: now },
    { id: "r5", test: "t5", score: 120, passed: true, data: "{}", createdAt: now, updatedAt: now },
  ]);
});

afterAll(async () => {
  await db.destroy();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ref subquery: dot-notation via queryFromClient", () => {
  it("whereIn('test.category', [...]) should filter results by referenced test category", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {}, // no scope
      [
        {
          method: "whereIn",
          args: ["test.category", ["biometric", "wearable", "fitness"]],
        },
      ],
    );

    const results = await chain.find();
    const ids = results.map((r: any) => r.id).sort();
    // t1(biometric), t2(wearable), t3(fitness), t5(biometric) all match
    expect(ids).toEqual(["r1", "r2", "r3", "r5"]);
  });

  it("where('test.category', value) should filter results by exact match", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [{ method: "where", args: ["test.category", "cognitive"] }],
    );

    const results = await chain.find();
    expect(results).toHaveLength(1);
    expect((results[0] as any).id).toBe("r4");
  });

  it("where('test.status', '!=', 'archived') should negate via whereNotIn", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [{ method: "where", args: ["test.status", "!=", "archived"] }],
    );

    const results = await chain.find();
    const ids = results.map((r: any) => r.id).sort();
    // t1, t2, t3 are active → r1, r2, r3
    expect(ids).toEqual(["r1", "r2", "r3"]);
  });

  it("whereNot('test.category', value) should exclude results", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [{ method: "whereNot", args: ["test.category", "biometric"] }],
    );

    const results = await chain.find();
    const ids = results.map((r: any) => r.id).sort();
    // biometric = t1, t5 → r1, r5 excluded
    expect(ids).toEqual(["r2", "r3", "r4"]);
  });

  it("whereNotIn('test.category', [...]) should exclude multiple categories", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [
        {
          method: "whereNotIn",
          args: ["test.category", ["biometric", "cognitive"]],
        },
      ],
    );

    const results = await chain.find();
    const ids = results.map((r: any) => r.id).sort();
    // exclude biometric (t1,t5) and cognitive (t4) → r2, r3
    expect(ids).toEqual(["r2", "r3"]);
  });

  it("should throw on invalid nested column", async () => {
    expect(() =>
      adapter.queryFromClient(
        Result as unknown as ModelConstructor,
        {},
        [{ method: "where", args: ["test.nonexistent", "foo"] }],
      ),
    ).toThrow('Invalid column "nonexistent" on referenced model "test"');
  });

  it("should throw on non-ref dot-notation (not a ref column)", async () => {
    // "score.something" — score is a number, not a ref
    expect(() =>
      adapter.queryFromClient(
        Result as unknown as ModelConstructor,
        {},
        [{ method: "where", args: ["score.something", "foo"] }],
      ),
    ).toThrow('Invalid column "score.something" on model "result"');
  });

  it("should combine dot-notation with regular where clauses", async () => {
    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [
        {
          method: "whereIn",
          args: ["test.category", ["biometric", "wearable"]],
        },
        { method: "where", args: ["passed", true] },
      ],
    );

    const results = await chain.find();
    const ids = results.map((r: any) => r.id).sort();
    // biometric+wearable = t1,t2,t5 → r1(passed),r2(passed),r5(passed) — all passed
    expect(ids).toEqual(["r1", "r2", "r5"]);
  });
});

describe("Ref subquery: dot-notation via server-side query chain", () => {
  it("whereIn('test.category', [...]) should work on direct query chain", async () => {
    const results = await adapter
      .query(Result as unknown as ModelConstructor)
      .whereIn("test.category", ["fitness"])
      .find();

    expect(results).toHaveLength(1);
    expect((results[0] as any).id).toBe("r3");
  });

  it("where('test.status', 'active') should work on direct query chain", async () => {
    const results = await adapter
      .query(Result as unknown as ModelConstructor)
      .where("test.status", "active")
      .find();

    const ids = results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["r1", "r2", "r3"]);
  });
});

describe("Ref subquery: schema cache simulation", () => {
  it("should work when ref target has __schema set (normal case)", async () => {
    // __schema is already set from beforeAll — this is the happy path
    expect((Test as any).__schema).toBeDefined();
    expect((Result as any).__schema).toBeDefined();

    const chain = adapter.queryFromClient(
      Result as unknown as ModelConstructor,
      {},
      [{ method: "where", args: ["test.category", "biometric"] }],
    );

    const results = await chain.find();
    expect(results.length).toBeGreaterThan(0);
  });

  it("should resolve via model registry even when ref target __schema is missing (stale cache)", async () => {
    // Simulate stale cache: ref target is a bare { type } stub without __schema
    const staleSchema: SchemaDefinition = {
      test: { kind: "ref", target: { type: "test" } as any },
      score: "number",
      passed: "boolean",
    };
    const origSchema = (Result as any).__schema;

    try {
      (Result as any).__schema = staleSchema;

      // The adapter's model registry resolves "test" → Test constructor (which has __schema)
      const chain = adapter.queryFromClient(
        Result as unknown as ModelConstructor,
        {},
        [{ method: "where", args: ["test.category", "biometric"] }],
      );

      const results = await chain.find();
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (Result as any).__schema = origSchema;
    }
  });

  it("should fall through when no registry and no __schema on ref target", async () => {
    // Adapter without registerModels + stale cache = can't resolve ref
    const staleSchema: SchemaDefinition = {
      test: { kind: "ref", target: { type: "test" } as any },
      score: "number",
      passed: "boolean",
    };
    const origSchema = (Result as any).__schema;

    try {
      (Result as any).__schema = staleSchema;

      // No registry, no __schema on target — should still not crash,
      // builds subquery without column validation
      const chain = adapterNoRegistry.queryFromClient(
        Result as unknown as ModelConstructor,
        {},
        [{ method: "where", args: ["test.category", "biometric"] }],
      );

      const results = await chain.find();
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (Result as any).__schema = origSchema;
    }
  });
});
