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
  it("returns entries verbatim", async () => {
    const entries: MigrationEntry[] = [
      { name: "a", up: async () => {}, down: null, transaction: true },
      { name: "b", up: async () => {}, down: null, transaction: true },
    ];
    const source = new ParcaeMigrationSource(entries, "sqlite");
    expect(await source.getMigrations()).toEqual(entries);
    expect(source.getMigrationName(entries[0]!)).toBe("a");
  });

  it("forwards transaction config to Knex", async () => {
    const entry: MigrationEntry = {
      name: "a",
      up: async () => {},
      down: null,
      transaction: false,
    };
    const source = new ParcaeMigrationSource([entry], "sqlite");
    const content = await source.getMigration(entry);
    expect(content.config).toEqual({ transaction: false });
  });

  it("calls up() with a context including db + engine", async () => {
    let capturedCtx: Parameters<MigrationEntry["up"]>[0] | null = null;
    const entry: MigrationEntry = {
      name: "a",
      up: async (ctx) => {
        capturedCtx = ctx;
      },
      down: null,
      transaction: true,
    };
    const source = new ParcaeMigrationSource([entry], "postgres");
    const content = await source.getMigration(entry);

    const fakeKnex = {} as Knex;
    await content.up(fakeKnex);
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.db).toBe(fakeKnex);
    expect(capturedCtx!.engine).toBe("postgres");
    expect(capturedCtx!.log).toBeDefined();
  });

  it("throws from down() when no down handler provided", async () => {
    const entry: MigrationEntry = {
      name: "forward-only",
      up: async () => {},
      down: null,
      transaction: true,
    };
    const source = new ParcaeMigrationSource([entry], "sqlite");
    const content = await source.getMigration(entry);
    await expect(content.down({} as Knex)).rejects.toThrow(/forward-only/);
  });

  it("invokes user-provided down()", async () => {
    const down = vi.fn(async () => {});
    const entry: MigrationEntry = {
      name: "reversible",
      up: async () => {},
      down,
      transaction: true,
    };
    const source = new ParcaeMigrationSource([entry], "sqlite");
    const content = await source.getMigration(entry);
    await content.down({} as Knex);
    expect(down).toHaveBeenCalledTimes(1);
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
    const entries: MigrationEntry[] = [
      { name: "dup", up: async () => {}, down: null, transaction: true },
      { name: "dup", up: async () => {}, down: null, transaction: true },
    ];
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
