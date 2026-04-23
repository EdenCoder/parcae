/**
 * Tests for the migration() registration API and the Knex-backed runner.
 *
 * All tests run against an in-memory SQLite database so they're deterministic
 * and fast. Engine-specific behaviour (Postgres information_schema, etc.) is
 * tested at the integration level — here we verify the orchestration.
 */

import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS_TABLE,
  ParcaeMigrationSource,
  runMigrations,
} from "../adapters/migrations";
import {
  clearMigrations,
  getMigrations,
  migration,
  type MigrationEntry,
} from "../routing/migration";

function sqlite(): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
}

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
    const source = new ParcaeMigrationSource(entries, "sqlite");
    expect(await source.getMigrations()).toEqual(entries);
    expect(source.getMigrationName(entries[0]!)).toBe("a");
  });

  it("forwards transaction config to Knex", async () => {
    const entry = makeEntry({ transaction: false });
    const source = new ParcaeMigrationSource([entry], "sqlite");
    const content = await source.getMigration(entry);
    expect(content.config).toEqual({ transaction: false });
  });

  it("calls up() with a context including db + engine and writes a meta row", async () => {
    const db = sqlite();
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
      await db.schema.createTable("parcae_migration_meta", (t) => {
        t.string("name").primary();
        t.string("checksum").notNullable();
        t.text("description").nullable();
        t.string("ticket").nullable();
        t.integer("durationMs").notNullable();
        t.string("appliedAt").notNullable();
      });

      await content.up(db);
      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.db).toBe(db);
      expect(capturedCtx!.engine).toBe("postgres");
      expect(capturedCtx!.log).toBeDefined();

      const rows = await db("parcae_migration_meta").select("*");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe("a");
      expect(rows[0]!.description).toBe("probe");
      expect(rows[0]!.ticket).toBe("T-1");
      expect(typeof rows[0]!.durationMs).toBe("number");
    } finally {
      await db.destroy();
    }
  });

  it("throws from down() when no down handler provided", async () => {
    const entry = makeEntry({ name: "forward-only" });
    const source = new ParcaeMigrationSource([entry], "sqlite");
    const content = await source.getMigration(entry);
    await expect(content.down({} as Knex)).rejects.toThrow(/forward-only/);
  });

  it("invokes user-provided down() and deletes the meta row", async () => {
    const db = sqlite();
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
      const source = new ParcaeMigrationSource([entry], "sqlite");
      const content = await source.getMigration(entry);
      await content.down(db);
      expect(down).toHaveBeenCalledTimes(1);

      const rows = await db("parcae_migration_meta").select("*");
      expect(rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});

describe("runMigrations", () => {
  let db: Knex;

  beforeEach(() => {
    clearMigrations();
    db = sqlite();
  });

  afterEach(async () => {
    clearMigrations();
    await db.destroy();
  });

  it("is a no-op with no registered migrations", async () => {
    const result = await runMigrations({
      db,
      entries: getMigrations(),
      engine: "sqlite",
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
      engine: "sqlite",
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
      engine: "sqlite",
    });
    await runMigrations({
      db,
      entries: getMigrations(),
      engine: "sqlite",
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
      engine: "sqlite",
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
        engine: "sqlite",
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
        engine: "sqlite",
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
      runMigrations({ db, entries, engine: "sqlite" }),
    ).rejects.toThrow(/duplicate/);
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
    // With transaction: false, a throw AFTER a successful DDL is not rolled
    // back. Note: SQLite auto-commits DDL anyway, so this test primarily
    // verifies that we pass through the config without crashing. Real
    // non-transactional semantics are Postgres-only.
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
      engine: "sqlite",
    });
    expect(await db.schema.hasTable("no_tx")).toBe(true);
  });
});
