/**
 * Tests for the parcae_migration_meta table + checksum verification.
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MigrationChecksumError,
  META_TABLE,
  buildListing,
  classifyStatement,
  effectFromMeta,
  effectLabel,
  ensureMetaTable,
  extractRowCount,
  readMetaRows,
  sha256File,
  verifyChecksums,
  writeMetaRow,
} from "../adapters/migration-meta";
import type { MigrationEntry } from "../routing/migration";

function sqlite(): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
}

function tempFile(content = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "parcae-meta-"));
  const path = join(dir, "fixture.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

function makeEntry(overrides: Partial<MigrationEntry> = {}): MigrationEntry {
  return {
    name: overrides.name ?? "m",
    up: overrides.up ?? (async () => {}),
    down: overrides.down ?? null,
    transaction: overrides.transaction ?? true,
    description: overrides.description ?? null,
    ticket: overrides.ticket ?? null,
    path: overrides.path ?? null,
  };
}

import type { MigrationMetaRow } from "../adapters/migration-meta";
function makeMeta(
  overrides: Partial<MigrationMetaRow> & Pick<MigrationMetaRow, "name"> = {
    name: "m",
  },
): MigrationMetaRow {
  return {
    name: overrides.name,
    checksum: overrides.checksum ?? "",
    description: overrides.description ?? null,
    ticket: overrides.ticket ?? null,
    durationMs: overrides.durationMs ?? 0,
    writes: overrides.writes ?? 0,
    rowsAffected: overrides.rowsAffected ?? 0,
    appliedAt: overrides.appliedAt ?? new Date().toISOString(),
  };
}

describe("sha256File", () => {
  it("returns a 64-char hex string for existing files", () => {
    const path = tempFile("hello world");
    const hash = sha256File(path);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns empty string for null path", () => {
    expect(sha256File(null)).toBe("");
  });

  it("throws for missing files (prevents silent drift bypass)", () => {
    expect(() => sha256File("/nonexistent/path")).toThrow(
      /cannot read migration file for checksum/,
    );
  });

  it("throws for unreadable files (prevents chmod-bypass)", () => {
    const path = tempFile("some content");
    // Make the file unreadable. On systems that ignore chmod for root, we
    // skip rather than fail.
    try {
      require("node:fs").chmodSync(path, 0o000);
    } catch {
      return;
    }
    // Verify the chmod actually denied access before asserting.
    try {
      require("node:fs").readFileSync(path);
      // Read succeeded — user is likely root. Skip the assertion.
      return;
    } catch {
      // Good — read failed. Now sha256File should throw too.
    }
    try {
      expect(() => sha256File(path)).toThrow(
        /cannot read migration file for checksum/,
      );
    } finally {
      require("node:fs").chmodSync(path, 0o644);
    }
  });

  it("differs when content differs", () => {
    const a = tempFile("a");
    const b = tempFile("b");
    expect(sha256File(a)).not.toBe(sha256File(b));
  });
});

describe("ensureMetaTable", () => {
  let db: Knex;
  beforeEach(() => {
    db = sqlite();
  });
  afterEach(() => db.destroy());

  it("creates the table if absent", async () => {
    expect(await db.schema.hasTable(META_TABLE)).toBe(false);
    await ensureMetaTable(db);
    expect(await db.schema.hasTable(META_TABLE)).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureMetaTable(db);
    await ensureMetaTable(db);
    expect(await db.schema.hasTable(META_TABLE)).toBe(true);
  });

  it("uses the expected columns", async () => {
    await ensureMetaTable(db);
    await writeMetaRow(
      db,
      makeMeta({
        name: "x",
        checksum: "a".repeat(64),
        description: "desc",
        ticket: "T-1",
        durationMs: 42,
        writes: 3,
        rowsAffected: 5,
      }),
    );
    const rows = await readMetaRows(db);
    const row = rows.get("x")!;
    expect(row.checksum).toBe("a".repeat(64));
    expect(row.description).toBe("desc");
    expect(row.ticket).toBe("T-1");
    expect(row.durationMs).toBe(42);
    expect(row.writes).toBe(3);
    expect(row.rowsAffected).toBe(5);
  });

  it("does not throw when called concurrently (CREATE TABLE IF NOT EXISTS)", async () => {
    // Two replicas can race this at boot. The CREATE TABLE IF NOT EXISTS +
    // ensureColumn wrappers must tolerate duplicate-table / duplicate-column.
    await expect(
      Promise.all([
        ensureMetaTable(db),
        ensureMetaTable(db),
        ensureMetaTable(db),
      ]),
    ).resolves.not.toThrow();
    expect(await db.schema.hasTable(META_TABLE)).toBe(true);
  });
});

describe("writeMetaRow upsert", () => {
  let db: Knex;
  beforeEach(async () => {
    db = sqlite();
    await ensureMetaTable(db);
  });
  afterEach(() => db.destroy());

  it("is idempotent on duplicate keys (onConflict merge)", async () => {
    const row = makeMeta({
      name: "x",
      checksum: "a".repeat(64),
      description: "first",
      durationMs: 1,
      appliedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeMetaRow(db, row);
    await writeMetaRow(db, { ...row, description: "updated", durationMs: 2 });
    const meta = await readMetaRows(db);
    const got = meta.get("x")!;
    expect(got.description).toBe("updated");
    expect(got.durationMs).toBe(2);
  });
});

describe("verifyChecksums", () => {
  it("is a no-op when no meta rows exist", () => {
    const entries = [makeEntry({ name: "a", path: tempFile("a") })];
    verifyChecksums(entries, new Map(), false);
  });

  it("passes when file content matches recorded checksum", () => {
    const path = tempFile("content-A");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: sha256File(path),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    verifyChecksums(entries, meta, false);
  });

  it("throws MigrationChecksumError when content differs", () => {
    const path = tempFile("original");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "f".repeat(64), // arbitrary different hash
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    let thrown: unknown;
    try {
      verifyChecksums(entries, meta, false);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MigrationChecksumError);
    expect((thrown as MigrationChecksumError).drifted).toHaveLength(1);
    expect((thrown as MigrationChecksumError).drifted[0]!.name).toBe("a");
  });

  it("skips entries without a path (programmatic registration)", () => {
    const entries = [makeEntry({ name: "a", path: null })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "f".repeat(64),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    verifyChecksums(entries, meta, false); // would throw if we didn't skip
  });

  it("skips entries whose meta has no checksum (baselined)", () => {
    const path = tempFile("whatever");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "", // baselined without source, no checksum recorded
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    verifyChecksums(entries, meta, false);
  });

  it("bypasses verification entirely when allowDrift is true", () => {
    const path = tempFile("original");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "f".repeat(64),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    verifyChecksums(entries, meta, true);
  });

  it("reports multiple drifted migrations in one error", () => {
    const pA = tempFile("a");
    const pB = tempFile("b");
    const entries = [
      makeEntry({ name: "m_a", path: pA }),
      makeEntry({ name: "m_b", path: pB }),
    ];
    const meta = new Map([
      [
        "m_a",
        {
          name: "m_a",
          checksum: "f".repeat(64),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
      [
        "m_b",
        {
          name: "m_b",
          checksum: "e".repeat(64),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    try {
      verifyChecksums(entries, meta, false);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationChecksumError);
      expect((err as MigrationChecksumError).drifted.map((d) => d.name)).toEqual(
        ["m_a", "m_b"],
      );
    }
  });
});

describe("buildListing", () => {
  it("marks entries as pending when not in applied set", () => {
    const entries = [makeEntry({ name: "a" })];
    const result = buildListing(entries, new Set(), new Map());
    expect(result[0]!.state).toBe("pending");
  });

  it("marks entries as applied when in applied set + checksum matches", () => {
    const path = tempFile("content");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        makeMeta({
          name: "a",
          checksum: sha256File(path),
          durationMs: 5,
          appliedAt: "t",
        }),
      ],
    ]);
    const result = buildListing(entries, new Set(["a"]), meta);
    expect(result[0]!.state).toBe("applied");
    expect(result[0]!.durationMs).toBe(5);
  });

  it("marks entries as drift when checksum differs", () => {
    const path = tempFile("content");
    const entries = [makeEntry({ name: "a", path })];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "f".repeat(64),
          description: null,
          ticket: null,
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    const result = buildListing(entries, new Set(["a"]), meta);
    expect(result[0]!.state).toBe("drift");
  });

  it("adds orphan entries for applied names without a file", () => {
    const result = buildListing([], new Set(["ghost"]), new Map());
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("ghost");
    expect(result[0]!.state).toBe("orphan");
  });

  it("sorts by name", () => {
    const entries = [
      makeEntry({ name: "b" }),
      makeEntry({ name: "a" }),
      makeEntry({ name: "c" }),
    ];
    const result = buildListing(entries, new Set(), new Map());
    expect(result.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("classifies statements correctly", () => {
    expect(classifyStatement("SELECT 1")).toBe("read");
    expect(classifyStatement("  select * from t")).toBe("read");
    expect(classifyStatement("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(
      "read",
    );
    expect(classifyStatement("EXPLAIN SELECT 1")).toBe("read");

    expect(classifyStatement("UPDATE t SET x=1")).toBe("write");
    expect(classifyStatement("DELETE FROM t WHERE 1=1")).toBe("write");
    expect(classifyStatement("INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifyStatement("ALTER TABLE t ADD COLUMN x int")).toBe("write");
    expect(classifyStatement("CREATE INDEX i ON t(x)")).toBe("write");
    expect(classifyStatement("DROP TABLE t")).toBe("write");
    expect(classifyStatement("TRUNCATE t")).toBe("write");

    expect(classifyStatement("BEGIN")).toBe("noise");
    expect(classifyStatement("COMMIT")).toBe("noise");
    expect(classifyStatement("ROLLBACK")).toBe("noise");
    expect(classifyStatement("SET search_path TO public")).toBe("noise");
    expect(classifyStatement("SAVEPOINT sp1")).toBe("noise");
  });

  it("extractRowCount reads from pg and better-sqlite3 response shapes", () => {
    // pg — { rowCount } shape, readable from either post-processed or raw
    expect(extractRowCount({ rowCount: 5 })).toBe(5);
    expect(extractRowCount(null, { rowCount: 5 })).toBe(5);

    // better-sqlite3 raw — { changes } on the raw driver response
    expect(extractRowCount(null, { changes: 7 })).toBe(7);
    expect(extractRowCount({ changes: 7 })).toBe(7);

    // mysql2 — affectedRows
    expect(extractRowCount({ affectedRows: 3 })).toBe(3);

    // SQLite processed UPDATE/DEL — Knex collapses to plain number
    expect(extractRowCount(2)).toBe(2);

    // SQLite processed INSERT — Knex returns [lastID] array
    expect(extractRowCount([42], null, "INSERT INTO t VALUES (1)")).toBe(1);

    // A SELECT-result-shaped array without a matching INSERT sql → null
    expect(extractRowCount([{ id: 1 }, { id: 2 }])).toBeNull();

    // Nothing readable
    expect(extractRowCount(null)).toBeNull();
    expect(extractRowCount(undefined)).toBeNull();
    expect(extractRowCount("a string")).toBeNull();
  });

  it("effectFromMeta distinguishes baselined / read-only / no rows / rows", () => {
    // durationMs=0 + writes=0 + rowsAffected=0 → baseline
    expect(
      effectFromMeta(
        makeMeta({
          name: "a",
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
        }),
      ),
    ).toEqual({ kind: "baseline" });

    // writes=0 but durationMs>0 → read-only (probe-only run)
    expect(
      effectFromMeta(makeMeta({ name: "a", durationMs: 4, writes: 0 })),
    ).toEqual({ kind: "read-only" });

    // writes>0 but rowsAffected=0 → no rows
    expect(
      effectFromMeta(
        makeMeta({ name: "a", durationMs: 2, writes: 1, rowsAffected: 0 }),
      ),
    ).toEqual({ kind: "no rows", writes: 1 });

    // writes>0 and rowsAffected>0 → rows
    expect(
      effectFromMeta(
        makeMeta({ name: "a", durationMs: 2, writes: 1, rowsAffected: 42 }),
      ),
    ).toEqual({ kind: "rows", rows: 42, writes: 1 });

    expect(effectFromMeta(undefined)).toBeNull();
  });

  it("effectLabel produces readable strings", () => {
    expect(effectLabel({ kind: "read-only" })).toBe("read-only");
    expect(effectLabel({ kind: "no rows", writes: 1 })).toBe("no rows changed");
    expect(effectLabel({ kind: "rows", rows: 1, writes: 1 })).toBe("1 row");
    expect(effectLabel({ kind: "rows", rows: 42, writes: 3 })).toBe("42 rows");
    expect(effectLabel({ kind: "baseline" })).toBe("baseline");
    expect(effectLabel({ kind: "unknown" })).toBe("unknown");
    expect(effectLabel(null)).toBe("");
  });

  it("prefers entry metadata over meta-row metadata when both exist", () => {
    const entries = [
      makeEntry({ name: "a", description: "from-entry", ticket: "FRE-1" }),
    ];
    const meta = new Map([
      [
        "a",
        {
          name: "a",
          checksum: "",
          description: "from-meta",
          ticket: "old",
          durationMs: 0,
          writes: 0,
          rowsAffected: 0,
          appliedAt: "",
        },
      ],
    ]);
    const result = buildListing(entries, new Set(["a"]), meta);
    expect(result[0]!.description).toBe("from-entry");
    expect(result[0]!.ticket).toBe("FRE-1");
  });
});
