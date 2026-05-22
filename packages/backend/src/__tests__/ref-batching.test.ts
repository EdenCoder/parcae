/**
 * Integration tests for the request-scoped RefLoader wiring through
 * `BackendAdapter.findById` (DOL-1038).
 *
 * The flow under test:
 *
 *   1. `runWithRequestContext({ user, refLoader }, fn)` installs a
 *      loader on the AsyncLocalStorage scope.
 *   2. Inside `fn`, calling `adapter.findById(ModelClass, id)` multiple
 *      times concurrently coalesces into ONE batch query
 *      (`SELECT * WHERE id IN (...)`) instead of N individual lookups.
 *   3. Outside the scope (background jobs, tests with no request),
 *      `findById` falls back to the direct per-id query — preserving
 *      existing behaviour for the no-context path.
 *
 * Tests run against an in-memory SQLite database. Knex emits a
 * `query` event per dispatched SQL statement; we listen on it to
 * assert query count without mocking the adapter internals.
 */

import knexFactory, { type Knex } from "knex";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Model } from "@parcae/model";
import { BackendAdapter } from "../adapters/model";
import { RefLoader } from "../services/ref-loader";
import { runWithRequestContext } from "../services/context";

function sqlite(): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
}

/**
 * Build a real Model subclass for a test type. ts-morph schema
 * resolution doesn't run during test boot so we set `__schema` and
 * `type` explicitly — same shape the resolver would produce.
 */
function makeModel(typeName: string, schema: Record<string, any> = {}): any {
  class TestModel extends Model {
    static type = typeName;
    static __schema = schema;
  }
  return TestModel;
}

async function makeAdapter(db: Knex): Promise<BackendAdapter> {
  const adapter = new (BackendAdapter as any)({ read: db, write: db });
  await adapter.detectEngine("sqlite");
  return adapter as BackendAdapter;
}

/**
 * Capture every SQL statement Knex issues during a closure so we can
 * count how many lookups landed on the database.
 */
async function captureQueriesDuring(
  db: Knex,
  fn: () => Promise<void>,
): Promise<string[]> {
  const queries: string[] = [];
  const listener = (data: { sql: string }) => {
    queries.push(data.sql);
  };
  db.on("query", listener);
  try {
    await fn();
  } finally {
    // Knex has no public off() for the query event; we just stop
    // caring about subsequent events for this test scope.
    void listener;
  }
  return queries;
}

describe("BackendAdapter.findById — RefLoader integration", () => {
  let db: Knex;
  let adapter: BackendAdapter;
  let User: any;
  let Post: any;

  beforeEach(async () => {
    db = sqlite();
    User = makeModel("user", { name: "string" });
    Post = makeModel("post", { title: "string" });
    adapter = await makeAdapter(db);
    (adapter as any).registerModels([User, Post]);
    await adapter.ensureAllTables([User, Post]);

    // Seed: 5 users + 3 posts.
    await db("users").insert([
      { id: "u1", data: "{}", name: "Alice" },
      { id: "u2", data: "{}", name: "Bob" },
      { id: "u3", data: "{}", name: "Carol" },
      { id: "u4", data: "{}", name: "Dan" },
      { id: "u5", data: "{}", name: "Eve" },
    ]);
    await db("posts").insert([
      { id: "p1", data: "{}", title: "P1" },
      { id: "p2", data: "{}", title: "P2" },
      { id: "p3", data: "{}", title: "P3" },
    ]);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("coalesces N concurrent findById calls in a request scope into ONE batch query", async () => {
    const loadByIds = (adapter as any).batchFindByType.bind(adapter);
    const loader = new RefLoader(loadByIds);

    const ids = ["u1", "u2", "u3", "u4", "u5"];

    const queries = await captureQueriesDuring(db, async () => {
      await runWithRequestContext({ user: null, refLoader: loader }, async () => {
        const results = await Promise.all(
          ids.map((id) => adapter.findById(User, id)),
        );
        // All five resolved correctly.
        expect(
          results.map((u: any) => u?.name).sort(),
        ).toEqual(["Alice", "Bob", "Carol", "Dan", "Eve"]);
      });
    });

    // Naive path would have issued five `where id = ?` queries. With
    // the loader, exactly one `where id in (...)` query lands.
    const selectQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    expect(selectQueries).toHaveLength(1);
    expect(selectQueries[0]!).toMatch(/in \(/i);
  });

  it("groups by model type — one batch query per type, even when interleaved", async () => {
    const loader = new RefLoader(
      (adapter as any).batchFindByType.bind(adapter),
    );

    const queries = await captureQueriesDuring(db, async () => {
      await runWithRequestContext({ user: null, refLoader: loader }, async () => {
        await Promise.all([
          adapter.findById(User, "u1"),
          adapter.findById(Post, "p1"),
          adapter.findById(User, "u2"),
          adapter.findById(Post, "p2"),
          adapter.findById(User, "u3"),
        ]);
      });
    });

    const userQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    const postQueries = queries.filter((q) => /select.*from.+posts/i.test(q));
    expect(userQueries).toHaveLength(1);
    expect(postQueries).toHaveLength(1);
  });

  it("deduplicates the same id within a batch — 4 callers, one row, one query", async () => {
    const loader = new RefLoader(
      (adapter as any).batchFindByType.bind(adapter),
    );

    const queries = await captureQueriesDuring(db, async () => {
      await runWithRequestContext({ user: null, refLoader: loader }, async () => {
        const results = await Promise.all([
          adapter.findById(User, "u1"),
          adapter.findById(User, "u1"),
          adapter.findById(User, "u1"),
          adapter.findById(User, "u1"),
        ]);
        // All four callers got the same data.
        expect(results.every((u: any) => u?.name === "Alice")).toBe(true);
      });
    });

    const userQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    expect(userQueries).toHaveLength(1);
  });

  it("resolves missing ids to null without breaking the batch for present ids", async () => {
    const loader = new RefLoader(
      (adapter as any).batchFindByType.bind(adapter),
    );

    await runWithRequestContext({ user: null, refLoader: loader }, async () => {
      const [present, missing] = await Promise.all([
        adapter.findById(User, "u1"),
        adapter.findById(User, "does-not-exist"),
      ]);
      expect((present as any)?.name).toBe("Alice");
      expect(missing).toBeNull();
    });
  });

  it("falls back to the direct per-id query when no request scope is active", async () => {
    const queries = await captureQueriesDuring(db, async () => {
      // No runWithRequestContext wrapper — `getRefLoader()` returns null.
      await Promise.all([
        adapter.findById(User, "u1"),
        adapter.findById(User, "u2"),
      ]);
    });

    // Without the loader, each findById issues its own SELECT.
    const userQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    expect(userQueries).toHaveLength(2);
  });

  it("falls back to the direct query when a context is active but has no refLoader", async () => {
    const queries = await captureQueriesDuring(db, async () => {
      await runWithRequestContext({ user: null }, async () => {
        await Promise.all([
          adapter.findById(User, "u1"),
          adapter.findById(User, "u2"),
        ]);
      });
    });

    const userQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    expect(userQueries).toHaveLength(2);
  });

  it("batchFindByType returns a Map<id, hydrated model> — useful for direct callers too", async () => {
    const result = await (adapter as any).batchFindByType(
      "user",
      ["u1", "u3", "u5"],
    );
    expect(result).toBeInstanceOf(Map);
    expect((result as Map<string, any>).get("u1").name).toBe("Alice");
    expect((result as Map<string, any>).get("u3").name).toBe("Carol");
    expect((result as Map<string, any>).get("u5").name).toBe("Eve");
    expect((result as Map<string, any>).size).toBe(3);
  });

  it("batchFindByType skips empty id lists without touching the database", async () => {
    const queries = await captureQueriesDuring(db, async () => {
      const result = await (adapter as any).batchFindByType("user", []);
      expect((result as Map<string, any>).size).toBe(0);
    });
    const userQueries = queries.filter((q) => /select.*from.+users/i.test(q));
    expect(userQueries).toHaveLength(0);
  });

  it("batchFindByType returns an empty map for an unknown model type rather than throwing", async () => {
    const result = await (adapter as any).batchFindByType(
      "unknownType",
      ["u1", "u2"],
    );
    expect(result).toBeInstanceOf(Map);
    expect((result as Map<string, any>).size).toBe(0);
  });
});
