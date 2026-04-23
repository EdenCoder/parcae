/**
 * @parcae/backend — Migration runner
 *
 * Drives user-registered migrations through Knex's built-in migrator. We supply
 * a custom `migrationSource` that pulls from the in-memory registry populated
 * by `migration()` calls, so Parcae migrations are plain TypeScript modules
 * rather than filesystem-convention scripts.
 *
 * What we get from Knex:
 *   - `parcae_migrations` table — one row per applied migration (name, batch,
 *     migration_time)
 *   - `parcae_migrations_lock` — serialises concurrent runs across replicas
 *     via SELECT ... FOR UPDATE
 *   - Per-migration transactions with per-migration opt-out
 *   - Validation that each migration has up() and down() functions
 */

import type { Knex } from "knex";
import { log } from "../logger";
import type {
  Engine,
  MigrationContext,
  MigrationEntry,
} from "../routing/migration";

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
        const ctx: MigrationContext = { db: knex, engine, log };
        await entry.up(ctx);
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
}

export interface RunMigrationsResult {
  /** Migration names applied during this run (in order). Empty if up-to-date. */
  applied: string[];
  /** Total count of migrations discovered in the registry. */
  total: number;
}

/**
 * Validate the registry and invoke `knex.migrate.latest()` against it.
 *
 * Safe to call with an empty registry — no-ops and creates no tables.
 *
 * Throws if:
 *   - Two migrations share the same name (the registry should have caught
 *     this at registration, but we re-validate defensively in case entries
 *     were composed from multiple sources).
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
      throw new Error(
        `[parcae] duplicate migration name: "${entry.name}"`,
      );
    }
    seen.add(entry.name);
  }

  const source = new ParcaeMigrationSource(sorted, opts.engine);
  const tableName = opts.tableName ?? MIGRATIONS_TABLE;

  log.info(`Running migrations — ${total} registered`);

  // Knex returns [batchNo, appliedNames]. Types from @types/knex wrap this as
  // any[] on some versions, so we narrow explicitly.
  const result = (await opts.db.migrate.latest({
    tableName,
    migrationSource: source as unknown as Knex.MigrationSource<unknown>,
  })) as [number, string[]];

  const applied = Array.isArray(result) ? (result[1] ?? []) : [];

  if (applied.length === 0) {
    log.info(`Migrations up to date — ${total} total, 0 applied`);
  } else {
    for (const name of applied) log.success(`Applied migration: ${name}`);
    log.info(
      `Migrations complete — ${applied.length} applied, ${total - applied.length} already up to date`,
    );
  }

  return { applied, total };
}
