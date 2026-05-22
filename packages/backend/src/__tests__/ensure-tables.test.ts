/**
 * Tests for `BackendAdapter.ensureAllTables()` — startup schema management.
 *
 * The performance-critical change here (DOL-1039) is replacing the
 * previous O(models × columns) sequential `hasColumn` queries with a
 * single bulk introspection of `pragma_table_info` (SQLite) or
 * `information_schema.columns` (Postgres). The behavioral surface
 * stays identical except for one new feature: when
 * `PARCAE_DROP_OBSOLETE_COLUMNS=true`, columns that exist in the DB
 * but are no longer declared on the model are dropped.
 *
 * Tests run against an in-memory SQLite database. Engine-specific
 * branches (Postgres-only DDL like `vector(768)`) are covered at the
 * integration level — here we verify the orchestration.
 */

import knexFactory, { type Knex } from "knex";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BackendAdapter } from "../adapters/model";

function sqlite(): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
}

/**
 * Builds a minimal `ModelConstructor`-shaped object suitable for
 * exercising the adapter's schema management. We don't extend the real
 * `Model` class because the relevant inputs are entirely static
 * metadata (`type`, `__schema`, `indexes`, etc.) and constructing real
 * `Model` instances would drag in adapter setup and ts-morph schema
 * resolution we don't need.
 */
function makeModel(
  type: string,
  schema: Record<string, any>,
  opts: {
    indexes?: (string | string[])[];
    searchFields?: string[];
    managed?: boolean;
  } = {},
): any {
  return {
    type,
    __schema: schema,
    indexes: opts.indexes ?? [],
    searchFields: opts.searchFields,
    managed: opts.managed,
  };
}

async function makeAdapter(db: Knex): Promise<BackendAdapter> {
  const adapter = new (BackendAdapter as any)({
    read: db,
    write: db,
  });
  // SQLite path skips the Postgres-only LISTEN/NOTIFY trigger install.
  await adapter.detectEngine("sqlite");
  return adapter as BackendAdapter;
}

/**
 * Capture every SQL statement Knex issues. Used to assert that
 * re-running `ensureAllTables` against a matched schema does NOT
 * re-introspect every column individually.
 */
function captureQueries(db: Knex): { queries: string[]; stop: () => void } {
  const queries: string[] = [];
  const listener = (data: { sql: string }) => {
    queries.push(data.sql);
  };
  db.on("query", listener);
  return {
    queries,
    stop: () => {
      // Knex doesn't expose an off helper for "query" — replace with
      // a no-op equivalent by reinstating the listener array minus
      // ours. For the in-memory test scope we just stop using the
      // captured list; the listener stays attached to a doomed
      // connection.
      void listener;
    },
  };
}

describe("BackendAdapter.ensureAllTables — bulk schema introspection", () => {
  let db: Knex;

  beforeEach(() => {
    db = sqlite();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates tables for new models with the expected columns", async () => {
    const adapter = await makeAdapter(db);
    const Post = makeModel("post", { title: "string", body: "text" });

    await adapter.ensureAllTables([Post]);

    // Table exists.
    expect(await db.schema.hasTable("posts")).toBe(true);
    // System columns.
    expect(await db.schema.hasColumn("posts", "id")).toBe(true);
    expect(await db.schema.hasColumn("posts", "createdAt")).toBe(true);
    expect(await db.schema.hasColumn("posts", "updatedAt")).toBe(true);
    expect(await db.schema.hasColumn("posts", "tmp")).toBe(true);
    expect(await db.schema.hasColumn("posts", "data")).toBe(true);
    // Schema columns.
    expect(await db.schema.hasColumn("posts", "title")).toBe(true);
    expect(await db.schema.hasColumn("posts", "body")).toBe(true);
  });

  it("adds missing columns to existing tables", async () => {
    const adapter = await makeAdapter(db);
    // Round 1: only `title`.
    await adapter.ensureAllTables([makeModel("post", { title: "string" })]);
    expect(await db.schema.hasColumn("posts", "body")).toBe(false);

    // Round 2: add `body`. Should be additive.
    await adapter.ensureAllTables([
      makeModel("post", { title: "string", body: "text" }),
    ]);
    expect(await db.schema.hasColumn("posts", "title")).toBe(true);
    expect(await db.schema.hasColumn("posts", "body")).toBe(true);
  });

  it("is effectively a no-op when schema matches (uses bulk introspection on re-run)", async () => {
    const adapter = await makeAdapter(db);
    const models = [
      makeModel("post", { title: "string", body: "text" }),
      makeModel("user", { name: "string", email: "string" }),
    ];

    // First pass creates tables.
    await adapter.ensureAllTables(models);

    // Capture queries from the second pass.
    const { queries } = captureQueries(db);
    await adapter.ensureAllTables(models);

    // Knex's `hasColumn` on SQLite emits `PRAGMA table_info(...)` per
    // call. The old code path called it once per (model, column) =
    // O(models × columns) total. Bulk introspection should issue at
    // most one such probe per table (or fewer if it joins through
    // `sqlite_master`). For 2 models × 4+ columns each this would be
    // 10+ probes under the old code; we cap at 4 — enough headroom
    // for a bulk path that elects to do one PRAGMA per table.
    const tableInfoProbes = queries.filter((q) =>
      /PRAGMA table_info/i.test(q),
    );
    expect(tableInfoProbes.length).toBeLessThanOrEqual(4);
  });

  it("respects externally-managed models — no introspection, no DDL", async () => {
    const adapter = await makeAdapter(db);
    const Unmanaged = makeModel("external", { foo: "string" }, {
      managed: false,
    });

    await adapter.ensureAllTables([Unmanaged]);

    // The table should NOT have been created.
    expect(await db.schema.hasTable("externals")).toBe(false);
  });
});

describe("BackendAdapter.ensureAllTables — obsolete columns", () => {
  let db: Knex;
  const FLAG = "PARCAE_DROP_OBSOLETE_COLUMNS";

  beforeEach(() => {
    db = sqlite();
    delete process.env[FLAG];
  });

  afterEach(async () => {
    delete process.env[FLAG];
    await db.destroy();
  });

  it("does not drop obsolete columns by default", async () => {
    // Pre-seed a table with an extra column.
    await db.schema.createTable("posts", (t) => {
      t.string("id").primary();
      t.text("data");
      t.datetime("createdAt");
      t.datetime("updatedAt");
      t.string("tmp", 2048).nullable();
      t.string("title", 2048);
      t.string("legacy_field", 2048); // <- no longer declared
    });

    const adapter = await makeAdapter(db);
    await adapter.ensureAllTables([
      makeModel("post", { title: "string" }),
    ]);

    // Default behavior: legacy_field is preserved.
    expect(await db.schema.hasColumn("posts", "legacy_field")).toBe(true);
    expect(await db.schema.hasColumn("posts", "title")).toBe(true);
  });

  it("logs a warning about obsolete columns at INFO level so operators can detect drift", async () => {
    await db.schema.createTable("posts", (t) => {
      t.string("id").primary();
      t.text("data");
      t.datetime("createdAt");
      t.datetime("updatedAt");
      t.string("tmp", 2048).nullable();
      t.string("legacy_one", 2048);
      t.string("legacy_two", 2048);
    });

    const adapter = await makeAdapter(db);
    const logSpy = vi.spyOn(
      // The adapter uses the same `log` module exported from `../logger`.
      // Spying on console.info is sufficient because the logger writes there.
      console,
      "log",
    );

    await adapter.ensureAllTables([
      makeModel("post", {}),
    ]);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toMatch(/legacy_one/);
    expect(allOutput).toMatch(/legacy_two/);
    // Operators should be pointed at the flag they can use.
    expect(allOutput).toMatch(/PARCAE_DROP_OBSOLETE_COLUMNS/);

    logSpy.mockRestore();
  });

  it("drops obsolete columns when PARCAE_DROP_OBSOLETE_COLUMNS=true", async () => {
    await db.schema.createTable("posts", (t) => {
      t.string("id").primary();
      t.text("data");
      t.datetime("createdAt");
      t.datetime("updatedAt");
      t.string("tmp", 2048).nullable();
      t.string("title", 2048);
      t.string("legacy_field", 2048);
      t.string("other_legacy", 2048);
    });

    process.env[FLAG] = "true";
    const adapter = await makeAdapter(db);
    await adapter.ensureAllTables([
      makeModel("post", { title: "string" }),
    ]);

    expect(await db.schema.hasColumn("posts", "legacy_field")).toBe(false);
    expect(await db.schema.hasColumn("posts", "other_legacy")).toBe(false);
    // Still-declared and parcae-owned columns are preserved.
    expect(await db.schema.hasColumn("posts", "title")).toBe(true);
    expect(await db.schema.hasColumn("posts", "id")).toBe(true);
    expect(await db.schema.hasColumn("posts", "data")).toBe(true);
  });

  it("never drops parcae-owned columns even when the flag is on", async () => {
    // Pre-seed including search/embedding columns that a previous
    // schema version installed via `static searchFields`. The model
    // no longer declares searchFields — but we must not drop these.
    await db.schema.createTable("posts", (t) => {
      t.string("id").primary();
      t.text("data");
      t.datetime("createdAt");
      t.datetime("updatedAt");
      t.string("tmp", 2048).nullable();
      t.string("title", 2048);
      // Search-related columns owned by a prior incarnation of the model.
      t.text("_search");
      t.text("_embedding");
    });

    process.env[FLAG] = "true";
    const adapter = await makeAdapter(db);
    await adapter.ensureAllTables([
      // Note: no `searchFields` declared; in the old model they were
      // present. The flag should NOT cause us to drop them — they're
      // parcae-managed columns.
      makeModel("post", { title: "string" }),
    ]);

    expect(await db.schema.hasColumn("posts", "id")).toBe(true);
    expect(await db.schema.hasColumn("posts", "data")).toBe(true);
    expect(await db.schema.hasColumn("posts", "createdAt")).toBe(true);
    expect(await db.schema.hasColumn("posts", "updatedAt")).toBe(true);
    expect(await db.schema.hasColumn("posts", "tmp")).toBe(true);
    expect(await db.schema.hasColumn("posts", "_search")).toBe(true);
    expect(await db.schema.hasColumn("posts", "_embedding")).toBe(true);
  });

  it("ignores obsolete columns on externally-managed tables", async () => {
    await db.schema.createTable("externals", (t) => {
      t.string("id").primary();
      t.text("data");
      t.string("created_by_outside_system", 2048);
    });

    process.env[FLAG] = "true";
    const adapter = await makeAdapter(db);
    await adapter.ensureAllTables([
      makeModel("external", { id: "string" }, { managed: false }),
    ]);

    // Externally-managed = adapter does not touch the table at all,
    // including when the drop flag is on.
    expect(await db.schema.hasColumn("externals", "created_by_outside_system")).toBe(true);
  });
});
