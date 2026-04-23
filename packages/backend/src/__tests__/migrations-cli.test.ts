/**
 * CLI command tests.
 *
 * Each command's `run()` takes an optional pre-built `CliRuntime`; we inject
 * one in tests to bypass file discovery (whose dynamically-imported files
 * would land on Node's native ESM loader and fracture the module graph).
 * Migrations are registered via `migration()` directly — the same public
 * API users call — and path-tagged manually to exercise checksum + meta
 * behaviour.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as runMake } from "../cli/commands/make";
import { run as runList } from "../cli/commands/list";
import { run as runStatus } from "../cli/commands/status";
import { run as runLatest } from "../cli/commands/latest";
import { run as runBaseline } from "../cli/commands/baseline";
import { run as runUnlock } from "../cli/commands/unlock";
import { run as runRollback } from "../cli/commands/rollback";
import { run as runPlan } from "../cli/commands/plan";
import { parseArgv } from "../cli/argv";
import type { CliRuntime } from "../cli/runtime";
import {
  clearMigrations,
  getMigrations,
  migration,
} from "../routing/migration";
import type { MigrationHandler } from "../routing/migration";
import { MIGRATIONS_TABLE } from "../adapters/migrations";
import { META_TABLE, ensureMetaTable } from "../adapters/migration-meta";

// ─── Test harness ────────────────────────────────────────────────────────────

function tempDbFile(): string {
  return join(mkdtempSync(join(tmpdir(), "parcae-cli-")), "test.db");
}

function tempMigrationsDir(): string {
  return mkdtempSync(join(tmpdir(), "parcae-migs-"));
}

function sqlite(path: string): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: path },
    useNullAsDefault: true,
  });
}

/**
 * Write a stub file on disk (content matters only for checksum purposes)
 * and register a matching migration via `migration()`, tagging it with the
 * file path so the meta table gets a meaningful checksum.
 */
function registerAndWrite(
  dir: string,
  name: string,
  handler: MigrationHandler,
  opts: { content?: string; down?: MigrationHandler } = {},
): string {
  const filePath = resolve(dir, `${name}.ts`);
  writeFileSync(
    filePath,
    opts.content ?? `// fixture: ${name}\nexport default null;\n`,
    "utf8",
  );
  migration(name, { down: opts.down }, handler);
  const entry = getMigrations().find((e) => e.name === name)!;
  entry.path = filePath;
  return filePath;
}

async function makeRuntime(
  dbPath: string,
  dir: string,
): Promise<CliRuntime> {
  const db = sqlite(dbPath);
  await ensureMetaTable(db);
  return {
    db,
    engine: "sqlite",
    entries: [...getMigrations()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    dir,
    tableName: MIGRATIONS_TABLE,
    close: () => db.destroy(),
  };
}

// ─── Argv parser ─────────────────────────────────────────────────────────────

describe("argv parser", () => {
  it("parses a command with no flags", () => {
    expect(parseArgv(["migrate:status"])).toEqual({
      command: "migrate:status",
      positional: [],
      flags: {},
    });
  });

  it("parses --flag value", () => {
    const r = parseArgv(["migrate:make", "foo", "--dir", "/tmp"]);
    expect(r.command).toBe("migrate:make");
    expect(r.positional).toEqual(["foo"]);
    expect(r.flags).toEqual({ dir: "/tmp" });
  });

  it("parses --flag=value", () => {
    expect(parseArgv(["x", "--dir=/tmp"])).toEqual({
      command: "x",
      positional: [],
      flags: { dir: "/tmp" },
    });
  });

  it("parses bare booleans", () => {
    expect(parseArgv(["x", "--json"])).toEqual({
      command: "x",
      positional: [],
      flags: { json: true },
    });
  });

  it("parses --no-flag as false", () => {
    expect(parseArgv(["x", "--no-json"])).toEqual({
      command: "x",
      positional: [],
      flags: { json: false },
    });
  });

  it("treats -h / --help as flags.help", () => {
    expect(parseArgv(["-h"]).flags.help).toBe(true);
    expect(parseArgv(["--help"]).flags.help).toBe(true);
  });

  it("stops flag parsing after --", () => {
    const r = parseArgv(["x", "--", "--not-a-flag"]);
    expect(r.positional).toEqual(["--not-a-flag"]);
    expect(r.flags).toEqual({});
  });
});

// ─── migrate:make ───────────────────────────────────────────────────────────

describe("migrate:make", () => {
  it("creates a timestamped migration file with a stub body", async () => {
    const dir = tempMigrationsDir();
    const result = await runMake(["rename-types"], { dir });
    expect(result.data.path).toMatch(/\d{14}-rename-types\.ts$/);
    expect(existsSync(result.data.path)).toBe(true);

    const body = readFileSync(result.data.path, "utf8");
    expect(body).toContain('import { migration }');
    expect(body).toContain(result.data.name);
    expect(body).toContain("async ({ db, engine, log })");
  });

  it("creates the migrations directory if missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parcae-make-"));
    const dir = join(parent, "nested", "migrations");
    const result = await runMake(["x"], { dir });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(result.data.path)).toBe(true);
  });

  it("rejects empty slugs", async () => {
    const dir = tempMigrationsDir();
    await expect(runMake(["!!!"], { dir })).rejects.toThrow(
      /slugifies to empty/,
    );
  });

  it("requires a name", async () => {
    await expect(runMake([], {})).rejects.toThrow(/Usage/);
  });
});

// ─── migrate:status / list / latest / plan lifecycle ───────────────────────

describe("lifecycle: status / list / latest / plan", () => {
  let dbPath: string;
  let dir: string;
  let rt: CliRuntime;

  beforeEach(async () => {
    clearMigrations();
    dbPath = tempDbFile();
    dir = tempMigrationsDir();
  });

  afterEach(async () => {
    if (rt) await rt.close();
    clearMigrations();
  });

  it("status reports zeros when no migrations exist", async () => {
    rt = await makeRuntime(dbPath, dir);
    const result = await runStatus([], {}, rt);
    expect(result.data).toEqual({
      total: 0,
      applied: 0,
      pending: 0,
      drift: 0,
      orphans: 0,
    });
  });

  it("list + status + latest + plan work together over a lifecycle", async () => {
    registerAndWrite(dir, "20260101000000-init", async ({ db }) => {
      await db.schema.createTable("t1", (t) => t.string("id").primary());
    });
    registerAndWrite(dir, "20260101000001-second", async ({ db }) => {
      await db.schema.createTable("t2", (t) => t.string("id").primary());
    });

    rt = await makeRuntime(dbPath, dir);

    const s1 = await runStatus([], {}, rt);
    expect(s1.data).toMatchObject({ total: 2, applied: 0, pending: 2 });

    const p = await runPlan([], {}, rt);
    expect(p.data.migration).toBe("20260101000000-init");
    expect(p.data.statements.length).toBeGreaterThan(0);
    expect(p.data.skipped).toBe(false);

    // Plan rolled back — still 2 pending
    const s2 = await runStatus([], {}, rt);
    expect(s2.data.pending).toBe(2);

    const l = await runLatest([], {}, rt);
    expect(l.data.applied).toEqual([
      "20260101000000-init",
      "20260101000001-second",
    ]);
    expect(l.data.total).toBe(2);

    const lst = await runList([], {}, rt);
    expect(lst.data.migrations).toHaveLength(2);
    for (const m of lst.data.migrations) {
      expect(m.state).toBe("applied");
      expect(typeof m.durationMs).toBe("number");
      expect(m.appliedAt).toBeTruthy();
    }

    // Plan is now a no-op
    const p2 = await runPlan([], {}, rt);
    expect(p2.data.migration).toBeNull();
  });

  it("list reports orphan state for DB rows with no corresponding file", async () => {
    registerAndWrite(dir, "20260101000000-kept", async ({ db }) => {
      await db.schema.createTable("t1", (t) => t.string("id").primary());
    });
    const orphanPath = registerAndWrite(
      dir,
      "20260101000001-orphan",
      async ({ db }) => {
        await db.schema.createTable("t2", (t) => t.string("id").primary());
      },
    );
    rt = await makeRuntime(dbPath, dir);
    await runLatest([], {}, rt);

    // Simulate orphan: delete file + re-register only the kept one
    unlinkSync(orphanPath);
    clearMigrations();
    registerAndWrite(dir, "20260101000000-kept", async () => {});

    const rt2 = await makeRuntime(dbPath, dir);
    try {
      const lst = await runList([], {}, rt2);
      const orphan = lst.data.migrations.find((m) =>
        m.name.endsWith("orphan"),
      );
      expect(orphan?.state).toBe("orphan");
    } finally {
      await rt2.close();
    }
  });

  it("list reports drift state when a file is edited after application", async () => {
    const p = registerAndWrite(dir, "20260101000000-drift", async ({ db }) => {
      await db.schema.createTable("t1", (t) => t.string("id").primary());
    });
    rt = await makeRuntime(dbPath, dir);
    await runLatest([], {}, rt);

    // Edit the file after applying
    writeFileSync(p, readFileSync(p, "utf8") + "\n// edited\n");

    const lst = await runList([], {}, rt);
    expect(lst.data.migrations[0]!.state).toBe("drift");
  });

  it("latest throws on drift by default, accepts --allow-checksum-drift", async () => {
    const p = registerAndWrite(
      dir,
      "20260101000000-drift",
      async ({ db }) => {
        await db.schema.createTable("t1", (t) => t.string("id").primary());
      },
    );
    rt = await makeRuntime(dbPath, dir);
    await runLatest([], {}, rt);

    writeFileSync(p, readFileSync(p, "utf8") + "\n// edited\n");

    await expect(runLatest([], {}, rt)).rejects.toThrow(/checksum drift/);

    const retry = await runLatest(
      [],
      { "allow-checksum-drift": true },
      rt,
    );
    expect(retry.data.applied).toEqual([]);
  });

  it("plan refuses to run a { transaction: false } migration", async () => {
    registerAndWrite(dir, "20260101000000-no-tx", async ({ db }) => {
      await db.schema.createTable("t1", (t) => t.string("id").primary());
    });
    // Patch the registered entry to non-transactional
    getMigrations().find((e) => e.name === "20260101000000-no-tx")!.transaction =
      false;
    rt = await makeRuntime(dbPath, dir);

    const p = await runPlan([], {}, rt);
    expect(p.data.skipped).toBe(true);
    expect(p.data.skipReason).toContain("transaction: false");
    expect(p.exitCode).toBe(2);
  });
});

// ─── migrate:baseline ───────────────────────────────────────────────────────

describe("migrate:baseline", () => {
  let dbPath: string;
  let dir: string;
  let rt: CliRuntime;

  beforeEach(() => {
    clearMigrations();
    dbPath = tempDbFile();
    dir = tempMigrationsDir();
  });

  afterEach(async () => {
    if (rt) await rt.close();
    clearMigrations();
  });

  it("stamps migrations up to <name> as applied without running them", async () => {
    registerAndWrite(dir, "20260101000000-a", async ({ db }) => {
      await db.schema.createTable("t_a", (t) => t.string("id").primary());
    });
    registerAndWrite(dir, "20260101000001-b", async ({ db }) => {
      await db.schema.createTable("t_b", (t) => t.string("id").primary());
    });
    registerAndWrite(dir, "20260101000002-c", async ({ db }) => {
      await db.schema.createTable("t_c", (t) => t.string("id").primary());
    });
    rt = await makeRuntime(dbPath, dir);

    const result = await runBaseline(
      ["20260101000001-b"],
      {},
      rt,
    );

    expect(result.data.stamped).toEqual([
      "20260101000000-a",
      "20260101000001-b",
    ]);
    expect(await rt.db.schema.hasTable("t_a")).toBe(false);
    expect(await rt.db.schema.hasTable("t_b")).toBe(false);
    expect(await rt.db.schema.hasTable("t_c")).toBe(false);

    const applied = await rt.db<{ name: string }>(MIGRATIONS_TABLE).select(
      "name",
    );
    expect(applied.map((r) => r.name).sort()).toEqual([
      "20260101000000-a",
      "20260101000001-b",
    ]);
    const meta = await rt.db<{ name: string }>(META_TABLE).select("name");
    expect(meta.map((r) => r.name).sort()).toEqual([
      "20260101000000-a",
      "20260101000001-b",
    ]);
  });

  it("dry-run doesn't write anything", async () => {
    registerAndWrite(dir, "20260101000000-a", async () => {});
    rt = await makeRuntime(dbPath, dir);

    const result = await runBaseline(
      ["20260101000000-a"],
      { "dry-run": true },
      rt,
    );
    expect(result.data.dryRun).toBe(true);
    expect(result.data.stamped).toEqual(["20260101000000-a"]);
    expect(await rt.db.schema.hasTable(MIGRATIONS_TABLE)).toBe(false);
  });

  it("errors when <name> doesn't match any migration", async () => {
    registerAndWrite(dir, "20260101000000-a", async () => {});
    rt = await makeRuntime(dbPath, dir);
    await expect(runBaseline(["nonexistent"], {}, rt)).rejects.toThrow(
      /no migration named/,
    );
  });

  it("requires a name", async () => {
    await expect(runBaseline([], {})).rejects.toThrow(/Usage/);
  });

  it("baselined migrations don't re-run on migrate:latest", async () => {
    registerAndWrite(dir, "20260101000000-a", async ({ db }) => {
      await db.schema.createTable("t_a", (t) => t.string("id").primary());
    });
    registerAndWrite(dir, "20260101000001-b", async ({ db }) => {
      await db.schema.createTable("t_b", (t) => t.string("id").primary());
    });
    rt = await makeRuntime(dbPath, dir);

    await runBaseline(["20260101000000-a"], {}, rt);
    const result = await runLatest([], {}, rt);

    expect(result.data.applied).toEqual(["20260101000001-b"]);
    expect(await rt.db.schema.hasTable("t_a")).toBe(false);
    expect(await rt.db.schema.hasTable("t_b")).toBe(true);
  });
});

// ─── migrate:unlock ─────────────────────────────────────────────────────────

describe("migrate:unlock", () => {
  it("does not throw against a fresh DB (no lock table)", async () => {
    const dbPath = tempDbFile();
    const dir = tempMigrationsDir();
    const rt = await makeRuntime(dbPath, dir);
    try {
      await runUnlock([], {}, rt);
    } finally {
      await rt.close();
    }
  });
});

// ─── migrate:rollback ───────────────────────────────────────────────────────

describe("migrate:rollback", () => {
  let dbPath: string;
  let dir: string;
  let rt: CliRuntime;

  beforeEach(() => {
    clearMigrations();
    dbPath = tempDbFile();
    dir = tempMigrationsDir();
  });

  afterEach(async () => {
    if (rt) await rt.close();
    clearMigrations();
  });

  it("returns empty when nothing's applied", async () => {
    rt = await makeRuntime(dbPath, dir);
    const result = await runRollback([], {}, rt);
    expect(result.data.rolledBack).toEqual([]);
  });

  it("refuses to roll back migrations that have no down()", async () => {
    registerAndWrite(dir, "20260101000000-forward-only", async ({ db }) => {
      await db.schema.createTable("t_x", (t) => t.string("id").primary());
    });
    rt = await makeRuntime(dbPath, dir);
    await runLatest([], {}, rt);
    await expect(runRollback([], {}, rt)).rejects.toThrow(
      /no down\(\) handler/,
    );
  });

  it("rolls back the last batch when down() handlers exist", async () => {
    let downCalled = false;
    registerAndWrite(
      dir,
      "20260101000000-reversible",
      async ({ db }) => {
        await db.schema.createTable("t_rev", (t) => t.string("id").primary());
      },
      {
        down: async ({ db }) => {
          downCalled = true;
          await db.schema.dropTableIfExists("t_rev");
        },
      },
    );
    rt = await makeRuntime(dbPath, dir);
    await runLatest([], {}, rt);
    expect(await rt.db.schema.hasTable("t_rev")).toBe(true);

    const result = await runRollback([], {}, rt);
    expect(result.data.rolledBack).toEqual(["20260101000000-reversible"]);
    expect(downCalled).toBe(true);
    expect(await rt.db.schema.hasTable("t_rev")).toBe(false);
  });
});

