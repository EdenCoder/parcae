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
 */

import type { Knex } from "knex";
import { log } from "../logger";
import type { Engine } from "./engine";
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

/** Knex's MigrationSource interface — see knex/lib/migrations/migrate/sources. */
interface KnexMigrationSource<T> {
  getMigrations(loadExtensions?: readonly string[]): Promise<T[]>;
  getMigrationName(migration: T): string;
  getMigration(
    migration: T,
  ): Promise<{
    up: (knex: Knex) => Promise<unknown>;
    down: (knex: Knex) => Promise<unknown>;
    config?: { transaction?: boolean };
  }>;
}

export const MIGRATIONS_TABLE = "parcae_migrations";

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
  implements KnexMigrationSource<MigrationEntry>
{
  constructor(
    private readonly entries: readonly MigrationEntry[],
    private readonly engine: Engine,
  ) {}

  getMigrations(): Promise<MigrationEntry[]> {
    return Promise.resolve([...this.entries]);
  }

  getMigrationName(entry: MigrationEntry): string {
    return entry.name;
  }

  getMigration(entry: MigrationEntry) {
    const engine = this.engine;
    // Knex inspects `config.transaction` on this object to decide whether to
    // wrap the migration in a transaction. See Migrator._useTransaction.
    return Promise.resolve({
      config: { transaction: entry.transaction },
      up: async (knex: Knex): Promise<void> => {
        // Attach an effect counter before running the user's up(). We listen
        // for every statement Knex executes through this (possibly
        // transactional) handle, classify it, and sum any row counts. The
        // result tells us what the migration ACTUALLY did — a read-only
        // migration differs meaningfully from one that wrote N rows.
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

        const ctx: MigrationContext = { db: knex, engine, log };
        const started = performance.now();
        try {
          await entry.up(ctx);
        } finally {
          knex.removeListener("query", onQuery);
          knex.removeListener("query-response", onResponse);
        }
        const durationMs = Math.max(1, Math.round(performance.now() - started));

        const row: MigrationMetaRow = {
          name: entry.name,
          checksum: sha256File(entry.path),
          description: entry.description,
          ticket: entry.ticket,
          durationMs,
          writes,
          rowsAffected,
          appliedAt: new Date().toISOString(),
        };
        // `knex` here is either a plain connection or a transactional handle —
        // either way, `writeMetaRow` uses it verbatim. Meta writes that happen
        // inside a tx commit atomically with the user's DDL/DML.
        await writeMetaRow(knex, row);
      },
      down: async (knex: Knex): Promise<void> => {
        if (!entry.down) {
          throw new Error(
            `[parcae] migration "${entry.name}" is forward-only (no down()). ` +
              `Write a new compensating migration instead of rolling back.`,
          );
        }
        const ctx: MigrationContext = { db: knex, engine, log };
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

  const source = new ParcaeMigrationSource(sorted, opts.engine);
  const tableName = opts.tableName ?? MIGRATIONS_TABLE;

  log.info(`Running migrations — ${total} registered`);

  const result = (await opts.db.migrate.latest({
    tableName,
    migrationSource: source as unknown as Knex.MigrationSource<unknown>,
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
