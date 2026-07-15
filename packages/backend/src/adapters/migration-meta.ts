/**
 * @parcae/backend — migration metadata
 *
 * Companion table to Knex's `parcae_migrations`. Stores data Knex doesn't
 * track — checksum, description, ticket, duration, applied-at. We keep these
 * in a parallel table rather than altering Knex's schema so its migrator
 * stays untouched and upgradable.
 *
 * Writes happen inside the same Knex transaction as the migration itself,
 * so all three writes (`parcae_migrations`, `parcae_migration_meta`, and the
 * user's schema/data changes) commit atomically. A failure in any of them
 * rolls back the whole thing.
 *
 * For `{ transaction: false }` migrations, the meta write is best-effort
 * post-commit — documented as a narrow exception users opt into.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Knex } from "knex";
import { log } from "../logger";
import type { MigrationEntry } from "../routing/migration";

export const META_TABLE = "parcae_migration_meta";

export interface MigrationMetaRow {
  name: string;
  checksum: string;
  description: string | null;
  ticket: string | null;
  durationMs: number;
  /**
   * Count of non-SELECT statements the migration executed (ALTER, INSERT,
   * UPDATE, DELETE, DROP, CREATE, etc). `0` means the migration only
   * probed — classic read-only no-op. See `classifyStatement`.
   */
  writes: number;
  /**
   * Sum of `rowCount` across every DML statement in the migration. `0` means
   * either nothing matched (zero-row UPDATE/DELETE/INSERT) or only DDL ran,
   * which doesn't carry a row count.
   */
  rowsAffected: number;
  appliedAt: string; // ISO 8601
}

/**
 * Create the meta table if it doesn't exist. Idempotent and race-safe —
 * `CREATE TABLE IF NOT EXISTS` is atomic in Postgres, so two
 * replicas booting simultaneously won't collide. Same treatment for the
 * additive column upgrades: the `hasColumn` → `alterTable` sequence is
 * wrapped in try/catch so the second caller's "duplicate column" is tolerated.
 *
 * Applies additive column upgrades for older DBs that already have the
 * table but predate newer columns (`writes`, `rowsAffected`). Existing rows
 * get `0` defaults for both — correct for "applied, effect unknown".
 */
export async function ensureMetaTable(db: Knex): Promise<void> {
  await db.raw(`
      CREATE TABLE IF NOT EXISTS "${META_TABLE}" (
        "name"         VARCHAR(512) PRIMARY KEY,
        "checksum"     VARCHAR(64)  NOT NULL,
        "description"  TEXT,
        "ticket"       VARCHAR(128),
        "durationMs"   INTEGER      NOT NULL,
        "writes"       INTEGER      NOT NULL DEFAULT 0,
        "rowsAffected" INTEGER      NOT NULL DEFAULT 0,
        "appliedAt"    VARCHAR(32)  NOT NULL
      )
    `);

  // Additive upgrade — add newer columns to an existing meta table. The
  // try/catch tolerates the "duplicate column" a racing second caller hits
  // when its `hasColumn` was false at check-time but true at alter-time.
  await ensureColumn(db, "writes", async () => {
    await db.schema.alterTable(META_TABLE, (t) => {
      t.integer("writes").notNullable().defaultTo(0);
    });
  });
  await ensureColumn(db, "rowsAffected", async () => {
    await db.schema.alterTable(META_TABLE, (t) => {
      t.integer("rowsAffected").notNullable().defaultTo(0);
    });
  });
}

async function ensureColumn(
  db: Knex,
  column: string,
  add: () => Promise<void>,
): Promise<void> {
  if (await db.schema.hasColumn(META_TABLE, column)) return;
  try {
    await add();
  } catch (err) {
    // Another replica won the race and added the column first. Re-check —
    // if the column really exists now, swallow; otherwise, rethrow.
    if (!(await db.schema.hasColumn(META_TABLE, column))) throw err;
  }
}

/**
 * Compute the sha256 of a file's bytes, as a 64-char hex string.
 *
 * Returns `""` for a null path — the caller treats this as "unknown origin"
 * (programmatic registration, no source file) and skips verification.
 *
 * Throws when a path is given but the file can't be read. A silent `""` on
 * read failure would let an attacker bypass drift detection by making a
 * migration file unreadable (e.g. `chmod 000`); `verifyChecksums` would then
 * compare `""` to the recorded hash and silently skip the entry.
 */
export function sha256File(path: string | null): string {
  if (!path) return "";
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[parcae] cannot read migration file for checksum: ${path} — ${reason}`,
    );
  }
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Upsert a meta row inside the provided Knex connection (which may be a
 * transaction). Uses `onConflict().merge()` so retries after partial failures
 * don't throw on duplicate keys.
 */
export async function writeMetaRow(
  db: Knex,
  row: MigrationMetaRow,
): Promise<void> {
  await db(META_TABLE)
    .insert(row)
    .onConflict("name")
    .merge();
}

/**
 * Read all meta rows, keyed by migration name.
 */
export async function readMetaRows(
  db: Knex,
): Promise<Map<string, MigrationMetaRow>> {
  if (!(await db.schema.hasTable(META_TABLE))) return new Map();
  const rows = await db<MigrationMetaRow>(META_TABLE).select("*");
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * Thrown when an already-applied migration's source file no longer matches
 * the checksum recorded when it was first applied. Separate class so callers
 * can `instanceof`-match and decide whether to surface, bypass, or exit.
 */
export class MigrationChecksumError extends Error {
  constructor(
    public readonly drifted: readonly {
      readonly name: string;
      readonly expected: string;
      readonly actual: string;
    }[],
  ) {
    const lines = drifted
      .map(
        (d) =>
          `  - ${d.name}\n      expected: ${d.expected}\n      actual:   ${d.actual}`,
      )
      .join("\n");
    super(
      `[parcae] migration checksum drift — ${drifted.length} migration(s) ` +
        `have been edited after they were applied:\n${lines}\n\n` +
        `Revert the edits or, if you know what you're doing, rerun with ` +
        `--allow-checksum-drift (CLI) or ` +
        `PARCAE_ALLOW_CHECKSUM_DRIFT=true (app startup).`,
    );
    this.name = "MigrationChecksumError";
  }
}

/**
 * Compare each already-applied migration's current file content against
 * the recorded checksum. Throws `MigrationChecksumError` on any mismatch
 * unless `allowDrift` is true.
 *
 * Entries without a `path` (programmatic registration) are skipped — there
 * is no source file to hash.
 *
 * Entries that are recorded as applied but whose files no longer exist are
 * **not** treated as drift — they're orphans, handled by `migrate:list`.
 */
export function verifyChecksums(
  entries: readonly MigrationEntry[],
  meta: Map<string, MigrationMetaRow>,
  allowDrift: boolean,
): void {
  const drifted: Array<{ name: string; expected: string; actual: string }> = [];

  for (const entry of entries) {
    const recorded = meta.get(entry.name);
    if (!recorded) continue; // not applied yet
    if (!entry.path) continue; // programmatic — no source to check
    if (!recorded.checksum) continue; // baselined without checksum — skip

    const actual = sha256File(entry.path);
    if (actual && actual !== recorded.checksum) {
      drifted.push({
        name: entry.name,
        expected: recorded.checksum,
        actual,
      });
    }
  }

  if (drifted.length === 0) return;

  if (allowDrift) {
    // Audit-log every bypassed drift so operators leave a trail instead of
    // silently ignoring checksum mismatches.
    for (const d of drifted) {
      log.warn(
        `[parcae] checksum drift bypassed for "${d.name}" — ` +
          `expected ${d.expected.slice(0, 12)}…, actual ${d.actual.slice(0, 12)}…`,
      );
    }
    return;
  }

  throw new MigrationChecksumError(drifted);
}

/**
 * Descriptor used by `migrate:list` to classify every migration's state.
 */
export type MigrationState = "applied" | "pending" | "orphan" | "drift";

/**
 * Human-readable summary of what a migration actually did when it ran, used
 * by `migrate:list` and friends. Derived from `(writes, rowsAffected)`.
 *
 *   read-only      → writes == 0 — migration only probed, skipped any writes
 *   no rows        → writes > 0  but rowsAffected == 0 — DDL ran (or DML
 *                    matched zero rows); structurally possible no-op at the
 *                    data level
 *   N rows         → rowsAffected > 0 — real data changes
 *   baseline       → stamped via `migrate:baseline`, never executed
 *   unknown        → applied but meta row predates effect tracking
 */
export type MigrationEffect =
  | { kind: "read-only" }
  | { kind: "no rows"; writes: number }
  | { kind: "rows"; rows: number; writes: number }
  | { kind: "baseline" }
  | { kind: "unknown" };

export interface MigrationListing {
  name: string;
  state: MigrationState;
  description: string | null;
  ticket: string | null;
  durationMs: number | null;
  appliedAt: string | null;
  path: string | null;
  effect: MigrationEffect | null;
}

/** One-line human label for a MigrationEffect, used by CLI output. */
export function effectLabel(effect: MigrationEffect | null): string {
  if (!effect) return "";
  switch (effect.kind) {
    case "read-only":
      return "read-only";
    case "no rows":
      return "no rows changed";
    case "rows":
      return effect.rows === 1 ? "1 row" : `${effect.rows} rows`;
    case "baseline":
      return "baseline";
    case "unknown":
      return "unknown";
  }
}

/**
 * Extract a MigrationEffect from a meta row. A meta row with a durationMs
 * of exactly 0 AND writes=0 AND rowsAffected=0 is interpreted as a baseline
 * entry (stamped via `migrate:baseline`, never run). Otherwise the
 * writes/rowsAffected numbers drive the classification.
 */
export function effectFromMeta(
  row: MigrationMetaRow | undefined,
): MigrationEffect | null {
  if (!row) return null;
  // Baselines are stamped with durationMs=0; any real run takes at least
  // 1ms end-to-end by the time we round().
  if (row.durationMs === 0 && row.writes === 0 && row.rowsAffected === 0) {
    return { kind: "baseline" };
  }
  if (row.writes === 0) return { kind: "read-only" };
  if (row.rowsAffected === 0) return { kind: "no rows", writes: row.writes };
  return { kind: "rows", rows: row.rowsAffected, writes: row.writes };
}

// ── Statement classifier ──────────────────────────────────────────────────

const WRITE_PREFIX =
  /^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|COMMENT|GRANT|REVOKE|ANALYZE|REFRESH|CLUSTER|LOCK)\b/i;

const READ_PREFIX = /^\s*(SELECT|WITH|VALUES|SHOW|EXPLAIN)\b/i;

const NOISE_PREFIX =
  /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|DEALLOCATE|DISCARD|LISTEN|UNLISTEN|NOTIFY|START TRANSACTION)\b/i;

export type StatementKind = "write" | "read" | "noise";

/** Classify a raw SQL statement by its leading keyword. */
export function classifyStatement(sql: string): StatementKind {
  if (NOISE_PREFIX.test(sql)) return "noise";
  if (WRITE_PREFIX.test(sql)) return "write";
  if (READ_PREFIX.test(sql)) return "read";
  // Unknown statement — default to "write" so we don't hide effects.
  log.debug(
    `[parcae] unknown statement kind, counting as write: ${sql.slice(0, 120)}`,
  );
  return "write";
}

/**
 * Pluck a row count from a Knex `query-response` event payload.
 *
 * Shapes we need to handle:
 *
 *   pg DML           — response `{ rowCount: N, rows, command }` (via obj.response)
 *   pg post-process  — same as above
 *   SELECT           — response is an array of rows OR plain rows
 *
 * Rather than probe all those variants from a single arg, we accept both the
 * post-processed response AND the raw `obj.response` (set by the dialect's
   * `_query` before `processResponse`). The raw response is consistent enough
   * to extract a row count reliably; the post-processed value is a fallback.
 *
 * Returns `null` when the count can't be determined — which the caller must
 * distinguish from `0` ("DDL or unknown, don't sum").
 */
export function extractRowCount(
  postProcessed: unknown,
  raw?: unknown,
  _sql?: string,
): number | null {
  // Try the raw driver response first — it's the most consistent source.
  const fromRaw = readRowCount(raw);
  if (fromRaw !== null) return fromRaw;
  return readRowCount(postProcessed);
}

function readRowCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const r = value as {
    rowCount?: number | null;
  };
  if (typeof r.rowCount === "number") return r.rowCount;
  return null;
}

/**
 * Combine the registry, Knex's applied-migrations view, and the meta table
 * into a single list of migration descriptors — the canonical input for
 * `migrate:list` / `migrate:status`.
 */
export function buildListing(
  entries: readonly MigrationEntry[],
  applied: Set<string>,
  meta: Map<string, MigrationMetaRow>,
): MigrationListing[] {
  const result: MigrationListing[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    seen.add(entry.name);
    const metaRow = meta.get(entry.name);
    let state: MigrationState;
    if (!applied.has(entry.name)) {
      state = "pending";
    } else if (
      entry.path &&
      metaRow?.checksum &&
      sha256File(entry.path) !== metaRow.checksum
    ) {
      state = "drift";
    } else {
      state = "applied";
    }
    const effect =
      state === "pending"
        ? null
        : applied.has(entry.name) && !metaRow
          ? { kind: "unknown" as const }
          : effectFromMeta(metaRow);
    result.push({
      name: entry.name,
      state,
      description: entry.description ?? metaRow?.description ?? null,
      ticket: entry.ticket ?? metaRow?.ticket ?? null,
      durationMs: metaRow?.durationMs ?? null,
      appliedAt: metaRow?.appliedAt ?? null,
      path: entry.path,
      effect,
    });
  }

  // Orphans — applied in the DB but no file on disk. `meta` may or may not
  // have a row (baselined entries might not).
  for (const name of applied) {
    if (seen.has(name)) continue;
    const metaRow = meta.get(name);
    result.push({
      name,
      state: "orphan",
      description: metaRow?.description ?? null,
      ticket: metaRow?.ticket ?? null,
      durationMs: metaRow?.durationMs ?? null,
      appliedAt: metaRow?.appliedAt ?? null,
      path: null,
      effect: metaRow ? effectFromMeta(metaRow) : null,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
