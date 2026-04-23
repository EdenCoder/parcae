/**
 * @parcae/backend — migration()
 *
 * Schema/data migrations. Complements Parcae's additive-only ensureAllTables()
 * by handling the things it can't: renames, type changes, data backfills, new
 * constraints against dirty data.
 *
 * Built on Knex's migrator — we get state tracking (`parcae_migrations`),
 * multi-replica locking (`parcae_migrations_lock` via SELECT ... FOR UPDATE),
 * and per-migration transactions for free. The file-based registration here
 * mirrors the hook/job/route pattern.
 *
 * @example Basic migration — runs in a transaction by default
 *
 * ```typescript
 * // migrations/20260401-rename-type-columns.ts
 * import { migration } from "@parcae/backend";
 *
 * migration("20260401-rename-type-columns", async ({ db, engine, log }) => {
 *   if (engine === "sqlite") return; // pg-only — information_schema
 *
 *   const { rows } = await db.raw(
 *     `SELECT 1 FROM information_schema.columns
 *      WHERE table_name = 'activities' AND column_name = 'type'`,
 *   );
 *   if (rows.length > 0) {
 *     await db.raw(`ALTER TABLE activities RENAME COLUMN "type" TO "activityType"`);
 *     log.info("Renamed activities.type → activityType");
 *   }
 * });
 * ```
 *
 * @example Opt out of the default transaction
 *
 * Some operations (Postgres `CREATE INDEX CONCURRENTLY`, `VACUUM`, DDL that
 * can't run inside a tx) require `transaction: false`.
 *
 * ```typescript
 * migration(
 *   "20260402-concurrent-search-index",
 *   { transaction: false },
 *   async ({ db }) => {
 *     await db.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_body_trgm
 *                   ON posts USING gin (body gin_trgm_ops)`);
 *   },
 * );
 * ```
 *
 * @example Provide a down() for local dev rollback
 *
 * Migrations are forward-only by default — if you omit `down`, attempting to
 * roll back throws with a clear message pointing you at writing a compensating
 * migration. Provide `down` explicitly if you want local-dev reversibility.
 *
 * ```typescript
 * migration(
 *   "20260403-add-slug",
 *   {
 *     down: async ({ db }) => {
 *       await db.raw(`ALTER TABLE posts DROP COLUMN IF EXISTS slug`);
 *     },
 *   },
 *   async ({ db }) => {
 *     await db.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS slug text`);
 *   },
 * );
 * ```
 *
 * ## Ordering
 *
 * Migrations sort lexicographically by name. Use an ISO-date prefix
 * (`YYYYMMDD-description` or `YYYY-MM-DDTHHMM-description`) so ordering
 * reflects creation time.
 *
 * ## Guarantees
 *
 * - Each migration runs at most once per database (tracked in `parcae_migrations`).
 * - Default: wrapped in a transaction — partial failures roll back.
 * - Multi-replica safe — Knex's `parcae_migrations_lock` table serialises
 *   concurrent runs across processes.
 * - Runs BEFORE `ensureAllTables()` so renames/transforms happen before the
 *   additive schema pass would create parallel empty tables.
 *
 * ## Migrating an existing app into the system
 *
 * For apps that already ran ad-hoc migrations manually, mark the historical
 * ones as applied so they don't re-run against a DB that's already in the
 * target shape:
 *
 * ```sql
 * INSERT INTO parcae_migrations (name, batch, migration_time)
 * VALUES
 *   ('20260401-rename-type-columns', 0, now()),
 *   ...;
 * ```
 *
 * Alternatively, keep each migration idempotent (guarded with `IF EXISTS`
 * / `IF NOT EXISTS`) so re-running is a no-op — then let the system apply
 * them normally on first boot.
 */

import type { Knex } from "knex";
import type { log as logger } from "../logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Engine = "alloydb" | "postgres" | "sqlite";

export interface MigrationContext {
  /**
   * Knex connection. Transactional by default — every statement is part of
   * the migration's transaction unless `{ transaction: false }` is set.
   *
   * Use raw SQL (`db.raw(...)`) rather than Model APIs — migrations must
   * remain correct even if a model class is later renamed or removed.
   */
  db: Knex;
  /** Detected database engine. Use to gate engine-specific SQL. */
  engine: Engine;
  /** The Parcae logger. */
  log: typeof logger;
}

export type MigrationHandler = (
  ctx: MigrationContext,
) => Promise<void> | void;

export interface MigrationOptions {
  /**
   * Wrap the migration in a transaction. Default: `true`.
   *
   * Set to `false` for statements that can't run inside a transaction
   * (Postgres `CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX CONCURRENTLY`,
   * `ALTER TYPE ... ADD VALUE`, etc).
   */
  transaction?: boolean;
  /**
   * Optional rollback for local-dev use. If omitted, attempting to roll back
   * this migration throws — write a new compensating migration in production.
   */
  down?: MigrationHandler;
}

export interface MigrationEntry {
  name: string;
  up: MigrationHandler;
  down: MigrationHandler | null;
  transaction: boolean;
}

// ─── Global Migration Registry ───────────────────────────────────────────────

const registered: MigrationEntry[] = [];

/**
 * Return all registered migrations, sorted lexicographically by name.
 * Sorting ensures deterministic order regardless of filesystem iteration order.
 */
export function getMigrations(): MigrationEntry[] {
  return [...registered].sort((a, b) => a.name.localeCompare(b.name));
}

export function clearMigrations(): void {
  registered.length = 0;
}

// ─── Registration ────────────────────────────────────────────────────────────

function parseArgs(
  args: [MigrationHandler] | [MigrationOptions, MigrationHandler],
): { options: MigrationOptions; handler: MigrationHandler } {
  if (args.length === 1) return { options: {}, handler: args[0] };
  return { options: args[0], handler: args[1] };
}

/**
 * Register a schema/data migration.
 *
 * Migrations run exactly once per database, in lexicographic order of `name`,
 * before `ensureAllTables()`. See the module-level JSDoc for full semantics.
 */
export function migration(
  name: string,
  handler: MigrationHandler,
): MigrationEntry;
export function migration(
  name: string,
  options: MigrationOptions,
  handler: MigrationHandler,
): MigrationEntry;
export function migration(
  name: string,
  ...args: [MigrationHandler] | [MigrationOptions, MigrationHandler]
): MigrationEntry {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("[parcae/migration] name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new Error(
      `[parcae/migration] name must not have leading/trailing whitespace: "${name}"`,
    );
  }
  if (registered.some((m) => m.name === name)) {
    throw new Error(`[parcae/migration] duplicate migration name: "${name}"`);
  }

  const { options, handler } = parseArgs(args);
  if (typeof handler !== "function") {
    throw new Error(
      `[parcae/migration] "${name}": handler must be a function`,
    );
  }
  if (options.down !== undefined && typeof options.down !== "function") {
    throw new Error(
      `[parcae/migration] "${name}": options.down must be a function`,
    );
  }

  const entry: MigrationEntry = {
    name,
    up: handler,
    down: options.down ?? null,
    transaction: options.transaction ?? true,
  };
  registered.push(entry);
  return entry;
}
