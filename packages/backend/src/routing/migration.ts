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
 * migration("20260401-rename-type-columns", async ({ db, log }) => {
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
 * @example Backfill a model-declared column
 *
 * Migrations run before `ensureAllTables()`, so columns declared on a model's
 * `__schema` aren't present yet. Call `ensureModel()` first to add them, then
 * backfill. Idempotent on re-run.
 *
 * ```typescript
 * import { Post } from "../models/post";
 *
 * migration("20260423-backfill-slug", async ({ db, ensureModel }) => {
 *   await ensureModel(Post);
 *   await db.raw(
 *     `UPDATE posts SET slug = lower(title) WHERE slug IS NULL`,
 *   );
 * });
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
import type { ModelConstructor } from "@parcae/model";
import type { log as logger } from "../logger";
import type { Engine as DbEngine } from "../adapters/engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Engine = DbEngine;

export interface MigrationContext {
  /**
   * Knex connection. Transactional by default — every statement is part of
   * the migration's transaction unless `{ transaction: false }` is set.
   *
   * Use raw SQL (`db.raw(...)`) rather than Model APIs — migrations must
   * remain correct even if a model class is later renamed or removed.
   */
  db: Knex;
  /** Detected Postgres engine. Use to gate AlloyDB-specific SQL. */
  engine: Engine;
  /** The Parcae logger. */
  log: typeof logger;
  /**
   * Ensure a model's table and declared columns exist right now. Idempotent.
   *
   * Migrations run BEFORE `ensureAllTables()` (so renames/type-changes aren't
   * stranded by the additive pass), which means model-declared columns are
   * not yet present by default. Call `ensureModel(Foo)` at the top of a
   * migration that needs to read or backfill a column declared on `Foo`'s
   * `__schema` — the helper runs the same additive pass `ensureAllTables()`
   * would, scoped to the one model.
   *
   * DDL runs on the migration's knex handle, so it participates in the
   * migration's transaction when one is active. If the migration rolls
   * back, the column adds roll back with it; on retry, `ensureModel`
   * re-runs and re-adds them.
   *
   * Throws if `runMigrations()` was invoked without an adapter — e.g. from
   * the CLI before server boot. In that case, run migrations via server
   * boot, or add the columns explicitly with `db.raw("ALTER TABLE ...")`.
   */
  ensureModel: (modelClass: ModelConstructor) => Promise<void>;
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
  /**
   * Human-readable description, surfaced in `parcae migrate:list`. Optional
   * but recommended — a year from now your future self will thank you.
   */
  description?: string;
  /**
   * Ticket/PR reference (e.g. `FRE-303`, `#412`). Surfaced in
   * `parcae migrate:list` so you can jump from a migration back to the context
   * that produced it.
   */
  ticket?: string;
}

export interface MigrationEntry {
  name: string;
  up: MigrationHandler;
  down: MigrationHandler | null;
  transaction: boolean;
  description: string | null;
  ticket: string | null;
  /**
   * Absolute path to the migration file on disk. Set by the discovery helper
   * (`discoverMigrations()`) and used to compute the checksum recorded in
   * `parcae_migration_meta`. `null` for programmatically-registered migrations
   * (e.g. unit tests) — checksum verification is skipped in that case.
   */
  path: string | null;
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

/**
 * Internal accessor returning the raw registry in insertion order.
 *
 * Used by the discovery helper to correlate newly-registered entries with
 * the file that was just imported — a sorted view breaks that correlation
 * because sort position is not insertion position. Not part of the public
 * API; prefer `getMigrations()` for anything user-facing.
 *
 * @internal
 */
export function _getInsertionOrdered(): MigrationEntry[] {
  return registered;
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
  if (
    options.description !== undefined &&
    typeof options.description !== "string"
  ) {
    throw new Error(
      `[parcae/migration] "${name}": options.description must be a string`,
    );
  }
  if (options.ticket !== undefined && typeof options.ticket !== "string") {
    throw new Error(
      `[parcae/migration] "${name}": options.ticket must be a string`,
    );
  }

  const entry: MigrationEntry = {
    name,
    up: handler,
    down: options.down ?? null,
    transaction: options.transaction ?? true,
    description: options.description ?? null,
    ticket: options.ticket ?? null,
    path: null,
  };
  registered.push(entry);
  return entry;
}
