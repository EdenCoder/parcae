/**
 * @parcae/backend — Migration runner
 *
 * Drives user-registered migrations through Knex's built-in migrator. We supply
 * a custom `migrationSource` that pulls from the in-memory registry populated
 * by `migration()` calls, so Parcae migrations are plain TypeScript modules
 * rather than filesystem-convention scripts.
 *
 * On top of Knex's tracking (`parcae_migrations`) we maintain a parallel
 * `parcae_migration_meta` table keyed by the same name. That table stores
 * checksum, description, ticket, duration, and applied-at — surfaced by
 * the CLI, and used to detect drift when an already-applied migration's
 * source file is edited.
 *
 * Writes to the meta table happen inside the migration's transaction so
 * Knex's row, the meta row, and the user's schema changes commit atomically.
 *
 * ⚠️  `{ transaction: false }` migrations are an exception to the atomicity
 *     contract above: the user's DDL/DML commits immediately, then the meta
 *     write runs against the bare connection. If that write fails, Knex sees
 *     the migration as failed but the schema change is already on disk.
 *     Such migrations MUST be idempotent at the DB level — every statement
 *     guarded with `IF EXISTS` / `IF NOT EXISTS`, so a re-run against the
 *     mutated schema is a no-op. The wrapper retries the meta write once on
 *     failure before surfacing the error, and logs loudly so operators can
 *     manually reconcile if needed.
 */

import type { Knex } from "knex";
import type { ModelConstructor } from "@parcae/model";
import { log } from "../logger";
import type { Engine } from "./engine";
import type { BackendAdapter } from "./model";
import type {
  MigrationContext,
  MigrationEntry,
} from "../routing/migration";
import {
  classifyStatement,
  effectFromMeta,
  effectLabel,
  ensureMetaTable,
  extractRowCount,
  readMetaRows,
  sha256File,
  verifyChecksums,
  writeMetaRow,
  type MigrationMetaRow,
} from "./migration-meta";

export const MIGRATIONS_TABLE = "parcae_migrations";

/**
 * Attach effect-tracking listeners to a Knex connection. Call `detach()`
 * (typically from a `finally`) to remove the listeners and collect the totals.
 *
 * Counts every non-noise, non-read statement executed through `knex` and sums
 * any driver-reported row counts. Exported so counting behaviour can be unit
 * tested without a full migration run.
 */
export function attachEffectTracking(knex: Knex): {
  detach(): { writes: number; rowsAffected: number };
} {
  let writes = 0;
  let rowsAffected = 0;
  const sqlById = new Map<string, string>();

  const onQuery = (q: { __knexQueryUid?: string; sql?: string }) => {
    if (!q.sql || !q.__knexQueryUid) return;
    sqlById.set(q.__knexQueryUid, q.sql);
  };
  const onResponse = (
    response: unknown,
    q: {
      __knexQueryUid?: string;
      sql?: string;
      response?: unknown;
      context?: unknown;
    },
  ) => {
    const sql =
      (q.__knexQueryUid && sqlById.get(q.__knexQueryUid)) || q.sql || "";
    if (!sql) return;
    const kind = classifyStatement(sql);
    if (kind === "noise" || kind === "read") return;
    writes += 1;
    // Prefer the raw driver response (q.response / q.context) set by the
    // dialect's _query before Knex's post-processing — it's consistent
    // across pg + sqlite for DML row counts. Fall back to the
    // post-processed response for SQLite's "update returns plain N" path.
    const rc = extractRowCount(response, q.response ?? q.context, sql);
    if (typeof rc === "number" && rc > 0) rowsAffected += rc;
  };

  knex.on("query", onQuery);
  knex.on("query-response", onResponse);

  return {
    detach() {
      knex.removeListener("query", onQuery);
      knex.removeListener("query-response", onResponse);
      return { writes, rowsAffected };
    },
  };
}

/**
 * Meta write for a `{ transaction: false }` migration. The user's schema
 * change has already committed — we do not want a transient meta-write glitch
 * to lose that row and leave drift silently uncontested. Try once, wait 100ms,
 * try again; on both failures log an error pointing operators at the manual
 * recovery path (insert the meta row by hand) and rethrow so Knex treats the
 * migration as failed.
 *
 * `writer` is injectable for tests; production calls fall through to
 * `writeMetaRow`.
 */
export async function writeMetaRowWithRetry(
  db: Knex,
  row: MigrationMetaRow,
  writer: (db: Knex, row: MigrationMetaRow) => Promise<void> = writeMetaRow,
): Promise<void> {
  try {
    await writer(db, row);
    return;
  } catch (err) {
    log.warn(
      `[parcae] meta write for non-tx migration "${row.name}" failed, retrying in 100ms — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  await new Promise((r) => setTimeout(r, 100));
  try {
    await writer(db, row);
  } catch (err) {
    log.error(
      `[parcae] meta write for non-tx migration "${row.name}" failed on retry — ` +
        `the schema change has ALREADY committed but parcae_migration_meta has no row. ` +
        `Manual recovery: insert a row into parcae_migration_meta matching the succeeded migration. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Shape Knex actually hands back from `getMigration` — the public `Migration`
 * type omits the `config` field that Knex's Migrator inspects to decide
 * whether to wrap the migration in a transaction (see `_useTransaction`).
 */
type ParcaeMigrationSpec = Knex.Migration & {
  config?: { transaction?: boolean };
};

/**
 * Build the `ensureModel` helper exposed on `MigrationContext`. When an
 * adapter is provided, delegates to its additive schema pass, passing the
 * migration's knex handle so DDL participates in the migration's
 * transaction. When absent (e.g. CLI invocation before the server is
 * booted), returns a stub that throws with a clear recovery hint —
 * migrations that don't call `ensureModel` are unaffected.
 */
function buildEnsureModel(
  adapter: BackendAdapter | null,
  knex: Knex,
): (modelClass: ModelConstructor) => Promise<void> {
  if (adapter) {
    return (modelClass) => adapter.ensureTable(modelClass, { knex });
  }
  return async () => {
    throw new Error(
      "[parcae] ensureModel() is unavailable: runMigrations was called " +
        "without a BackendAdapter. Run migrations through server boot " +
        "(which threads the adapter automatically), or add columns " +
        "explicitly with `db.raw(\"ALTER TABLE ...\")`.",
    );
  };
}

/**
 * Adapts the in-memory migration registry to Knex's MigrationSource contract.
 *
 * Entries are expected to be pre-sorted by the caller (see `runMigrations`) —
 * Knex uses the order `getMigrations()` returns as authoritative.
 *
 * The `up()` wrapper times the migration and writes a meta row inside the
 * same transaction Knex provides. For `{ transaction: false }` migrations,
 * the wrapper still writes the meta row — just without transactional
 * atomicity, documented as an exception users opt into.
 */
export class ParcaeMigrationSource
  implements Knex.MigrationSource<MigrationEntry>
{
  constructor(
    private readonly entries: readonly MigrationEntry[],
    private readonly engine: Engine,
    private readonly adapter: BackendAdapter | null = null,
  ) {}

  getMigrations(_loadExtensions: readonly string[]): Promise<MigrationEntry[]> {
    return Promise.resolve([...this.entries]);
  }

  getMigrationName(entry: MigrationEntry): string {
    return entry.name;
  }

  getMigration(entry: MigrationEntry): Promise<ParcaeMigrationSpec> {
    const engine = this.engine;
    const adapter = this.adapter;
    // Knex inspects `config.transaction` on this object to decide whether to
    // wrap the migration in a transaction. See Migrator._useTransaction.
    return Promise.resolve({
      config: { transaction: entry.transaction },
      up: async (knex: Knex): Promise<void> => {
        const tracker = attachEffectTracking(knex);
        const ensureModel = buildEnsureModel(adapter, knex);
        const ctx: MigrationContext = { db: knex, engine, log, ensureModel };
        const started = performance.now();
        let effect: { writes: number; rowsAffected: number };
        try {
          await entry.up(ctx);
        } finally {
          effect = tracker.detach();
        }
        const durationMs = Math.max(1, Math.round(performance.now() - started));

        const row: MigrationMetaRow = {
          name: entry.name,
          checksum: sha256File(entry.path),
          description: entry.description,
          ticket: entry.ticket,
          durationMs,
          writes: effect.writes,
          rowsAffected: effect.rowsAffected,
          appliedAt: new Date().toISOString(),
        };
        // `knex` here is either a plain connection or a transactional handle.
        // Inside a tx, meta write commits atomically with the user's DDL/DML.
        // For `{ transaction: false }` migrations, the user's change has
        // already committed — a meta write failure here leaves us with the
        // schema mutation persisted but no meta row. We retry once, log
        // loudly on each failure, and ultimately rethrow so Knex marks the
        // migration failed (matching existing failure semantics).
        if (entry.transaction === false) {
          await writeMetaRowWithRetry(knex, row);
        } else {
          await writeMetaRow(knex, row);
        }
      },
      down: async (knex: Knex): Promise<void> => {
        if (!entry.down) {
          throw new Error(
            `[parcae] migration "${entry.name}" is forward-only (no down()). ` +
              `Write a new compensating migration instead of rolling back.`,
          );
        }
        const ensureModel = buildEnsureModel(adapter, knex);
        const ctx: MigrationContext = { db: knex, engine, log, ensureModel };
        await entry.down(ctx);
        // Remove the meta row for the rolled-back migration so re-applying
        // it on the next `up` doesn't see a stale checksum.
        await knex("parcae_migration_meta")
          .where({ name: entry.name })
          .delete();
      },
    });
  }
}

export interface RunMigrationsOptions {
  /** Knex write connection. The migrator creates its bookkeeping tables here. */
  db: Knex;
  /** Registered migration entries. Order is enforced by the runner. */
  entries: readonly MigrationEntry[];
  /** Detected engine — passed to each migration's context. */
  engine: Engine;
  /**
   * Backend adapter used to power `MigrationContext.ensureModel()`. Optional
   * because CLI callers may run migrations without a booted adapter; if
   * omitted, `ensureModel` throws with a recovery hint when called.
   */
  adapter?: BackendAdapter;
  /** Override the table name. Default: `parcae_migrations`. */
  tableName?: string;
  /**
   * Skip checksum verification even if drift is detected. Use as an emergency
   * escape hatch — normal recovery path is to revert the edit, or delete the
   * file and write a new compensating migration.
   */
  allowChecksumDrift?: boolean;
}

export interface RunMigrationsResult {
  /** Migration names applied during this run (in order). Empty if up-to-date. */
  applied: string[];
  /** Total count of migrations discovered in the registry. */
  total: number;
}

/**
 * Validate the registry, verify checksums of already-applied migrations,
 * and invoke `knex.migrate.latest()` against it.
 *
 * Safe to call with an empty registry — no-ops and creates no tables.
 *
 * Throws if:
 *   - Two migrations share the same name (defensive re-check).
 *   - An already-applied migration's file has been edited (checksum drift),
 *     unless `allowChecksumDrift` is true.
 *   - A migration throws inside its up() — Knex halts and rolls back the
 *     transaction (if enabled), and later migrations do not run.
 */
export async function runMigrations(
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const total = opts.entries.length;
  if (total === 0) return { applied: [], total };

  const sorted = [...opts.entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.name)) {
      throw new Error(`[parcae] duplicate migration name: "${entry.name}"`);
    }
    seen.add(entry.name);
  }

  // Ensure the meta table exists BEFORE we try to read/write it. Knex's
  // migration table is created by `migrate.latest()` on first run, so it may
  // not exist yet — that's fine, readMetaRows() returns an empty map.
  await ensureMetaTable(opts.db);

  const meta = await readMetaRows(opts.db);
  verifyChecksums(sorted, meta, opts.allowChecksumDrift ?? false);

  const source = new ParcaeMigrationSource(
    sorted,
    opts.engine,
    opts.adapter ?? null,
  );
  const tableName = opts.tableName ?? MIGRATIONS_TABLE;

  log.info(`Running migrations — ${total} registered`);

  const result = (await opts.db.migrate.latest({
    tableName,
    migrationSource: source,
  })) as [number, string[]];

  const applied = Array.isArray(result) ? (result[1] ?? []) : [];

  if (applied.length === 0) {
    log.info(`Migrations up to date — ${total} total, 0 applied`);
  } else {
    const postMeta = await readMetaRows(opts.db);
    for (const name of applied) {
      const row = postMeta.get(name);
      const ms = row?.durationMs;
      const effect = effectLabel(effectFromMeta(row));
      const parts: string[] = [];
      if (ms !== undefined) parts.push(`${ms}ms`);
      if (effect) parts.push(effect);
      const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      log.success(`Applied migration: ${name}${suffix}`);
    }
    log.info(
      `Migrations complete — ${applied.length} applied, ${total - applied.length} already up to date`,
    );
  }

  return { applied, total };
}
