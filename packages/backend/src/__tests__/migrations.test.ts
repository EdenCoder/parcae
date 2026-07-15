/**
 * Tests for the migration() registration API and the Knex-backed runner.
 *
 * Database-backed cases run against an isolated Postgres schema when
 * PARCAE_TEST_DATABASE_URL is available.
 */

import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS_TABLE,
  ParcaeMigrationSource,
  runMigrations,
  writeMetaRowWithRetry,
} from "../adapters/migrations";
import * as metaModule from "../adapters/migration-meta";
import { ensureMetaTable } from "../adapters/migration-meta";
import { BackendAdapter } from "../adapters/model";
import {
  clearMigrations,
  getMigrations,
  migration,
  type MigrationEntry,
} from "../routing/migration";
import {
  createPostgresTestDatabase,
  describePostgres,
  itPostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

describe("migration() registration", () => {
  beforeEach(() => clearMigrations());
  afterEach(() => clearMigrations());

  it("registers a migration with just a handler", () => {
    migration("001-init", async () => {});
    expect(getMigrations()).toHaveLength(1);
    expect(getMigrations()[0]!.name).toBe("001-init");
    expect(getMigrations()[0]!.transaction).toBe(true);
    expect(getMigrations()[0]!.down).toBeNull();
  });

  it("registers a migration with options", () => {
    const down = async () => {};
    migration("002-foo", { transaction: false, down }, async () => {});
    const [entry] = getMigrations();
    expect(entry!.transaction).toBe(false);
    expect(entry!.down).toBe(down);
  });

  it("sorts lexicographically regardless of registration order", () => {
    migration("003-c", async () => {});
    migration("001-a", async () => {});
    migration("002-b", async () => {});
    expect(getMigrations().map((m) => m.name)).toEqual([
      "001-a",
      "002-b",
      "003-c",
    ]);
  });

  it("rejects empty names", () => {
    expect(() => migration("", async () => {})).toThrow(/non-empty string/);
    expect(() => migration("   ", async () => {})).toThrow(/non-empty string/);
  });

  it("rejects names with surrounding whitespace", () => {
    expect(() => migration(" foo", async () => {})).toThrow(/whitespace/);
    expect(() => migration("foo ", async () => {})).toThrow(/whitespace/);
  });

  it("rejects duplicate names at registration time", () => {
    migration("001-dup", async () => {});
    expect(() => migration("001-dup", async () => {})).toThrow(/duplicate/);
  });

  it("rejects non-function handlers", () => {
    // @ts-expect-error — deliberately wrong
    expect(() => migration("001-bad", "not a function")).toThrow(
      /handler must be a function/,
    );
  });

  it("rejects non-function down()", () => {
    expect(() =>
      // @ts-expect-error — deliberately wrong
      migration("001-bad", { down: "nope" }, async () => {}),
    ).toThrow(/down must be a function/);
  });
});

describe("ParcaeMigrationSource", () => {
  function makeEntry(overrides: Partial<MigrationEntry> = {}): MigrationEntry {
    return {
      name: overrides.name ?? "a",
      up: overrides.up ?? (async () => {}),
      down: overrides.down ?? null,
      transaction: overrides.transaction ?? true,
      description: overrides.description ?? null,
      ticket: overrides.ticket ?? null,
      path: overrides.path ?? null,
    };
  }

  it("returns entries verbatim", async () => {
    const entries = [makeEntry({ name: "a" }), makeEntry({ name: "b" })];
    const source = new ParcaeMigrationSource(entries, "postgres");
    expect(await source.getMigrations([])).toEqual(entries);
    expect(source.getMigrationName(entries[0]!)).toBe("a");
  });

  it("forwards transaction config to Knex", async () => {
    const entry = makeEntry({ transaction: false });
    const source = new ParcaeMigrationSource([entry], "postgres");
    const content = await source.getMigration(entry);
    expect(content.config).toEqual({ transaction: false });
  });

  itPostgres("calls up() with a context including db + engine and writes a meta row", async () => {
    const database = await createPostgresTestDatabase();
    const { db } = database;
    try {
      let capturedCtx: Parameters<MigrationEntry["up"]>[0] | null = null;
      const entry = makeEntry({
        name: "a",
        description: "probe",
        ticket: "T-1",
        up: async (ctx) => {
          capturedCtx = ctx;
        },
      });
      const source = new ParcaeMigrationSource([entry], "postgres");
      const content = await source.getMigration(entry);

      // Meta table must exist for the up() wrapper's insert to succeed.
      await ensureMetaTable(db);

      await content.up(db);
      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.db).toBe(db);
      expect(capturedCtx!.engine).toBe("postgres");
      expect(capturedCtx!.log).toBeDefined();
      expect(typeof capturedCtx!.ensureModel).toBe("function");

      const rows = await db("parcae_migration_meta").select("*");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe("a");
      expect(rows[0]!.description).toBe("probe");
      expect(rows[0]!.ticket).toBe("T-1");
      expect(typeof rows[0]!.durationMs).toBe("number");
    } finally {
      await database.close();
    }
  });

  it("throws from down() when no down handler provided", async () => {
    const entry = makeEntry({ name: "forward-only" });
    const source = new ParcaeMigrationSource([entry], "postgres");
    const content = await source.getMigration(entry);
    await expect(content.down!({} as Knex)).rejects.toThrow(/forward-only/);
  });

  itPostgres("invokes user-provided down() and deletes the meta row", async () => {
    const database = await createPostgresTestDatabase();
    const { db } = database;
    try {
      await db.schema.createTable("parcae_migration_meta", (t) => {
        t.string("name").primary();
        t.string("checksum").notNullable();
        t.text("description").nullable();
        t.string("ticket").nullable();
        t.integer("durationMs").notNullable();
        t.string("appliedAt").notNullable();
      });
      await db("parcae_migration_meta").insert({
        name: "reversible",
        checksum: "",
        description: null,
        ticket: null,
        durationMs: 0,
        appliedAt: new Date().toISOString(),
      });

      const down = vi.fn(async () => {});
      const entry = makeEntry({ name: "reversible", down });
      const source = new ParcaeMigrationSource([entry], "postgres");
      const content = await source.getMigration(entry);
      await content.down!(db);
      expect(down).toHaveBeenCalledTimes(1);

      const rows = await db("parcae_migration_meta").select("*");
      expect(rows).toHaveLength(0);
    } finally {
      await database.close();
    }
  });
});

describePostgres("runMigrations", () => {
  let db: Knex;
  let database: PostgresTestDatabase;

  beforeEach(async () => {
    clearMigrations();
    database = await createPostgresTestDatabase();
    db = database.db;
  });

  afterEach(async () => {
    clearMigrations();
    await database.close();
  });

  it("is a no-op with no registered migrations", async () => {
    const result = await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });
    expect(result).toEqual({ applied: [], total: 0 });
    expect(await db.schema.hasTable(MIGRATIONS_TABLE)).toBe(false);
  });

  it("runs migrations in lexicographic order", async () => {
    const calls: string[] = [];
    migration("002-second", async ({ db }) => {
      calls.push("second");
      await db.schema.createTable("t2", (t) => t.string("id"));
    });
    migration("001-first", async ({ db }) => {
      calls.push("first");
      await db.schema.createTable("t1", (t) => t.string("id"));
    });

    const result = await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    expect(calls).toEqual(["first", "second"]);
    expect(result.applied).toEqual(["001-first", "002-second"]);
    expect(result.total).toBe(2);
    expect(await db.schema.hasTable("t1")).toBe(true);
    expect(await db.schema.hasTable("t2")).toBe(true);
  });

  it("tracks applied migrations so they don't re-run", async () => {
    let runs = 0;
    migration("001-once", async () => {
      runs++;
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });
    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    expect(runs).toBe(1);

    // State table exists with the applied entry
    expect(await db.schema.hasTable(MIGRATIONS_TABLE)).toBe(true);
    const rows = await db(MIGRATIONS_TABLE).select("name");
    expect(rows.map((r) => r.name)).toEqual(["001-once"]);
  });

  it("uses the parcae_migrations table name (namespaced from knex default)", async () => {
    migration("001-init", async () => {});
    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });
    expect(await db.schema.hasTable("parcae_migrations")).toBe(true);
    expect(await db.schema.hasTable("knex_migrations")).toBe(false);
  });

  it("rolls back inside a transaction on failure (default)", async () => {
    migration("001-fail", async ({ db }) => {
      await db.schema.createTable("should_not_exist", (t) =>
        t.string("id"),
      );
      throw new Error("boom");
    });

    await expect(
      runMigrations({
        db,
        entries: getMigrations(),
        engine: "postgres",
      }),
    ).rejects.toThrow();

    // Transaction should have rolled back the createTable
    expect(await db.schema.hasTable("should_not_exist")).toBe(false);
  });

  it("halts subsequent migrations when an earlier one fails", async () => {
    migration("001-fail", async () => {
      throw new Error("boom");
    });
    const laterCalls = vi.fn(async () => {});
    migration("002-later", laterCalls);

    await expect(
      runMigrations({
        db,
        entries: getMigrations(),
        engine: "postgres",
      }),
    ).rejects.toThrow();

    expect(laterCalls).not.toHaveBeenCalled();
  });

  it("detects duplicate names defensively even if registry was bypassed", async () => {
    const mk = (): MigrationEntry => ({
      name: "dup",
      up: async () => {},
      down: null,
      transaction: true,
      description: null,
      ticket: null,
      path: null,
    });
    const entries: MigrationEntry[] = [mk(), mk()];
    await expect(
      runMigrations({ db, entries, engine: "postgres" }),
    ).rejects.toThrow(/duplicate/);
  });

  it("records effect: read-only migration writes writes=0, rowsAffected=0", async () => {
    migration("001-probe-only", async ({ db }) => {
      // Only probes — simulates Freia's idempotent `SELECT FROM information_schema` guard
      const r = await db.raw("SELECT 1 AS n");
      void r;
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    const rows = await db("parcae_migration_meta").select("*");
    expect(rows[0]!.writes).toBe(0);
    expect(rows[0]!.rowsAffected).toBe(0);
  });

  it("records effect: DDL-only migration has writes>0 but rowsAffected=0", async () => {
    migration("001-ddl-only", async ({ db }) => {
      await db.schema.createTable("effect_ddl", (t) => t.string("id").primary());
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    const rows = await db("parcae_migration_meta").select("*");
    expect(rows[0]!.writes).toBeGreaterThan(0);
    expect(rows[0]!.rowsAffected).toBe(0);
  });

  it("records effect: data migration counts rowsAffected", async () => {
    await db.schema.createTable("effect_data", (t) => {
      t.string("id").primary();
      t.string("name");
    });
    await db("effect_data").insert([
      { id: "a", name: "old" },
      { id: "b", name: "old" },
      { id: "c", name: "keep" },
    ]);

    migration("001-update-rows", async ({ db }) => {
      await db("effect_data").where({ name: "old" }).update({ name: "new" });
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    const rows = await db("parcae_migration_meta").select("*");
    expect(rows[0]!.writes).toBe(1);
    expect(rows[0]!.rowsAffected).toBe(2); // only "old" rows updated
  });

  it("effect counters are scoped per migration — no cross-contamination", async () => {
    await db.schema.createTable("effect_iso", (t) => {
      t.string("id").primary();
      t.string("tag");
    });

    migration("001-seed", async ({ db }) => {
      await db("effect_iso").insert([
        { id: "a", tag: "x" },
        { id: "b", tag: "x" },
      ]);
    });
    migration("002-noop", async ({ db }) => {
      // Probe only
      await db("effect_iso").count("* as n").first();
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });

    const rows = await db("parcae_migration_meta").select("*").orderBy("name");
    expect(rows[0]!.name).toBe("001-seed");
    expect(rows[0]!.writes).toBe(1);
    expect(rows[0]!.rowsAffected).toBe(2);
    expect(rows[1]!.name).toBe("002-noop");
    expect(rows[1]!.writes).toBe(0);
    expect(rows[1]!.rowsAffected).toBe(0);
  });

  it("passes engine through to migration context", async () => {
    let seenEngine: string | null = null;
    migration("001-probe", async ({ engine }) => {
      seenEngine = engine;
    });
    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "alloydb",
    });
    expect(seenEngine).toBe("alloydb");
  });

  it("lets a migration opt out of the transaction", async () => {
    // With transaction: false, successful DDL is not wrapped in a transaction.
    migration(
      "001-no-tx",
      { transaction: false },
      async ({ db }) => {
        await db.schema.createTable("no_tx", (t) => t.string("id"));
      },
    );

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
    });
    expect(await db.schema.hasTable("no_tx")).toBe(true);
  });
});

describe("writeMetaRowWithRetry (non-tx meta atomicity)", () => {
  const row: metaModule.MigrationMetaRow = {
    name: "some-migration",
    checksum: "a".repeat(64),
    description: null,
    ticket: null,
    durationMs: 1,
    writes: 0,
    rowsAffected: 0,
    appliedAt: new Date().toISOString(),
  };

  afterEach(() => vi.restoreAllMocks());

  it("returns after a successful first attempt", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    await writeMetaRowWithRetry({} as Knex, row, writer);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("retries once on failure, succeeds on retry, and warns", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const writer = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    await writeMetaRowWithRetry({} as Knex, row, writer);

    expect(writer).toHaveBeenCalledTimes(2);
    const warnCalls = warn.mock.calls.flat().join(" ");
    expect(warnCalls).toMatch(/retrying/);
  });

  it("rethrows on second failure and logs error with manual-recovery hint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const writer = vi.fn().mockRejectedValue(new Error("persistent failure"));

    await expect(
      writeMetaRowWithRetry({} as Knex, row, writer),
    ).rejects.toThrow(/persistent failure/);
    expect(writer).toHaveBeenCalledTimes(2);
    const errCalls = errorLog.mock.calls.flat().join(" ");
    expect(errCalls).toMatch(/Manual recovery/);
  });
});

describePostgres("MigrationContext.ensureModel", () => {
  class ProbeModel {
    static type = "probeitem";
    static __schema = {
      name: "string" as const,
      count: "integer" as const,
    };
  }

  let db: Knex;
  let database: PostgresTestDatabase;

  beforeEach(async () => {
    clearMigrations();
    database = await createPostgresTestDatabase();
    db = database.db;
  });

  afterEach(async () => {
    clearMigrations();
    await database.close();
  });

  it("creates model-declared columns when called from a migration", async () => {
    const adapter = new BackendAdapter({ read: db, write: db });

    migration("001-backfill-probe", async ({ db, ensureModel }) => {
      await ensureModel(ProbeModel as any);
      // Column declared on __schema should now exist — backfill is safe.
      await db("probeitems").insert({
        id: "row-1",
        name: "seeded",
        count: 42,
        data: "{}",
      });
    });

    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "postgres",
      adapter,
    });

    expect(await db.schema.hasTable("probeitems")).toBe(true);
    expect(await db.schema.hasColumn("probeitems", "name")).toBe(true);
    expect(await db.schema.hasColumn("probeitems", "count")).toBe(true);

    const rows = await db("probeitems").select("*");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("seeded");
    expect(rows[0]!.count).toBe(42);
  });

  it("is idempotent — re-running a migration that calls ensureModel is a no-op", async () => {
    const adapter = new BackendAdapter({ read: db, write: db });

    // Pre-create the table with the model's columns to mimic a schema that's
    // already been ensured. ensureModel() should detect and skip.
    await db.schema.createTable("probeitems", (t) => {
      t.string("id").primary();
      t.string("name");
      t.integer("count");
      t.text("data");
      t.datetime("createdAt");
      t.datetime("updatedAt");
      t.string("tmp", 2048).nullable();
    });

    migration("001-idempotent", async ({ ensureModel }) => {
      await ensureModel(ProbeModel as any);
    });

    await expect(
      runMigrations({
        db,
        entries: getMigrations(),
        engine: "postgres",
        adapter,
      }),
    ).resolves.toBeDefined();
  });

  it("rolls back ensureModel DDL when the migration fails inside its transaction", async () => {
    const adapter = new BackendAdapter({ read: db, write: db });

    migration("001-fail-after-ensure", async ({ ensureModel }) => {
      await ensureModel(ProbeModel as any);
      // DDL committed inside the tx — if ensureModel threads the tx handle,
      // the throw below must roll back the column adds too.
      throw new Error("boom");
    });

    await expect(
      runMigrations({
        db,
        entries: getMigrations(),
        engine: "postgres",
        adapter,
      }),
    ).rejects.toThrow(/boom/);

    // Table must not exist: the tx rolled back the createTable from ensureModel.
    expect(await db.schema.hasTable("probeitems")).toBe(false);
  });

  it("throws with a recovery hint when runMigrations is called without an adapter", async () => {
    migration("001-needs-adapter", async ({ ensureModel }) => {
      await ensureModel(ProbeModel as any);
    });

    await expect(
      runMigrations({
        db,
        entries: getMigrations(),
        engine: "postgres",
        // adapter intentionally omitted
      }),
    ).rejects.toThrow(/ensureModel\(\) is unavailable/);
  });
});
