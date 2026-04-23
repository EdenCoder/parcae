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
  ensureMetaTable,
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

describe("sha256File", () => {
  it("returns a 64-char hex string for existing files", () => {
    const path = tempFile("hello world");
    const hash = sha256File(path);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns empty string for null path", () => {
    expect(sha256File(null)).toBe("");
  });

  it("returns empty string for missing files", () => {
    expect(sha256File("/nonexistent/path")).toBe("");
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
    await writeMetaRow(db, {
      name: "x",
      checksum: "a".repeat(64),
      description: "desc",
      ticket: "T-1",
      durationMs: 42,
      appliedAt: new Date().toISOString(),
    });
    const rows = await readMetaRows(db);
    const row = rows.get("x")!;
    expect(row.checksum).toBe("a".repeat(64));
    expect(row.description).toBe("desc");
    expect(row.ticket).toBe("T-1");
    expect(row.durationMs).toBe(42);
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
    const row = {
      name: "x",
      checksum: "a".repeat(64),
      description: "first",
      ticket: null,
      durationMs: 1,
      appliedAt: "2026-01-01T00:00:00.000Z",
    };
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
        {
          name: "a",
          checksum: sha256File(path),
          description: null,
          ticket: null,
          durationMs: 5,
          appliedAt: "t",
        },
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
          appliedAt: "",
        },
      ],
    ]);
    const result = buildListing(entries, new Set(["a"]), meta);
    expect(result[0]!.description).toBe("from-entry");
    expect(result[0]!.ticket).toBe("FRE-1");
  });
});
