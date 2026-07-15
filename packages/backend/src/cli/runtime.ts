/**
 * @parcae/backend — CLI runtime
 *
 * Shared bootstrap for every CLI command. Reuses the same config loader as
 * `createApp()` so behaviour between `parcae migrate:*` and the running
 * server stays consistent — same `.env` rules, same `DATABASE_URL`, same
 * engine detection.
 *
 * Unlike `createApp()`, the CLI does not:
 *   - connect Redis (migrations are DB-local)
 *   - resolve schemas or touch `.parcae/` cache
 *   - bring up the BackendAdapter
 *   - start a server or workers
 *
 * It only needs: a Knex connection, an engine tag, and a list of migration
 * entries with their source paths. That's it.
 */

import { resolve } from "node:path";
import type { Knex } from "knex";
import knexFactory from "knex";
import { parseConfig } from "../config";
import { detectEngine, type Engine } from "../adapters/engine";
import {
  discoverMigrations,
  listMigrationFiles,
} from "../adapters/migration-discovery";
import { clearMigrations, getMigrations } from "../routing/migration";
import type { MigrationEntry } from "../routing/migration";
import { MIGRATIONS_TABLE } from "../adapters/migrations";
import { ensureMetaTable } from "../adapters/migration-meta";

export interface CliRuntime {
  /** Write-side Knex connection. Always the primary, never a read replica. */
  db: Knex;
  /** Detected DB engine. */
  engine: Engine;
  /** All registered migrations, path-tagged, sorted by name. */
  entries: MigrationEntry[];
  /** Migrations directory resolved to an absolute path. */
  dir: string;
  /** Knex migrations table name — namespaced to `parcae_migrations`. */
  tableName: string;
  /** Close the DB connection. CLI commands should call this in a finally. */
  close(): Promise<void>;
}

export interface BootstrapOptions {
  /** `--dir <path>` override. Defaults to `./migrations` relative to cwd. */
  dir?: string;
  /** `--db <url>` override. Defaults to `DATABASE_URL` via parseConfig(). */
  db?: string;
  /**
   * Skip discovery. Use for commands that only need the DB (e.g. `unlock`,
   * `status` when no files are required — though `status` does need them).
   */
  skipDiscovery?: boolean;
  /**
   * Inject pre-registered migration entries instead of discovering them from
   * disk. Intended for tests where writing files + dynamic ESM import would
   * fracture the module graph. When provided, discovery is skipped entirely.
   */
  entries?: MigrationEntry[];
}

/**
 * Bootstrap a CLI runtime. Resolves config, opens Knex, discovers migrations,
 * ensures the meta table. Throws with a clear message on any failure — the
 * dispatcher catches and renders to stderr.
 *
 * Discovery resets the global registry first so repeated CLI invocations
 * inside the same process (e.g. tests) don't double-register.
 */
export async function bootstrap(
  opts: BootstrapOptions = {},
): Promise<CliRuntime> {
  const cwd = process.cwd();
  const config = opts.db
    ? // Bypass full parse when --db is given — just use the override
      { DATABASE_URL: opts.db }
    : (() => {
        try {
          return parseConfig(process.env, cwd);
        } catch (err) {
          throw new Error(
            `[parcae] could not load DATABASE_URL. ` +
              `Set it in the environment, in a .env file in ${cwd}, or pass ` +
              `--db <url>.\n\n` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      })();

  const dbUrl = config.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "[parcae] DATABASE_URL is empty. Pass --db <url> or set it in the environment.",
    );
  }

  if (!/^postgres(?:ql)?:\/\//.test(dbUrl)) {
    throw new Error("[parcae] DATABASE_URL must be a Postgres URL");
  }
  const db: Knex = knexFactory({
    client: "pg",
    connection: pgConnectionFromUrl(dbUrl),
    pool: { min: 1, max: 2 }, // CLI = short-lived, minimal pool
  });

  const engine: Engine = await detectEngine(db);
  await ensureMetaTable(db);

  const dir = resolve(opts.dir ?? "./migrations");

  let entries: MigrationEntry[] = [];
  if (opts.entries) {
    entries = [...opts.entries].sort((a, b) => a.name.localeCompare(b.name));
  } else if (!opts.skipDiscovery) {
    // Reset registry before re-discovering so a repeated CLI invocation
    // (common in tests) doesn't trip the duplicate-name guard.
    clearMigrations();
    await discoverMigrations(dir);
    entries = getMigrations();
  }

  return {
    db,
    engine,
    entries,
    dir,
    tableName: MIGRATIONS_TABLE,
    close: () => db.destroy(),
  };
}

/**
 * Read the set of migrations already applied in the DB, from Knex's
 * `parcae_migrations` table. Returns an empty set if the table doesn't exist
 * yet (first run).
 */
export async function readApplied(
  db: Knex,
  tableName: string,
): Promise<Set<string>> {
  if (!(await db.schema.hasTable(tableName))) return new Set();
  const rows = await db<{ name: string }>(tableName).select("name");
  return new Set(rows.map((r) => r.name));
}

/** Slugify a user-supplied migration name for the `migrate:make` filename. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse a Postgres connection URL into the object shape pg accepts. Passing an
 * object rather than the raw URL reduces the chance the driver echoes the
 * password back in error messages. Unparseable URLs fall through to the
 * original string — pg will attempt its own parse and fail loudly.
 */
export function pgConnectionFromUrl(
  url: string,
): string | {
  host: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const params = parsed.searchParams;
  const sslParam = params.get("ssl") ?? params.get("sslmode");
  let ssl: boolean | { rejectUnauthorized: boolean } | undefined;
  if (sslParam === "true" || sslParam === "require") ssl = true;
  else if (sslParam === "no-verify")
    ssl = { rejectUnauthorized: false };
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname.replace(/^\//, "") || undefined,
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

/** Produce a `YYYYMMDDHHMMSS` timestamp used for migration filenames. */
export function timestamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

/** Re-export for command files, avoiding circular imports. */
export { listMigrationFiles };
