/**
 * @parcae/backend — Configuration
 *
 * Zod-validated env vars with sensible defaults. Fail-fast on missing required config.
 */

import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load .env file into process.env if it exists.
 * Supports basic KEY=VALUE format with # comments.
 */
function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Parse a boolean-like env string. Returns `true`, `false`, or `null` for
 * unrecognised values (which Zod converts to a validation error).
 *
 * Accepts: true/false, 1/0, yes/no, on/off, empty string → false.
 * Used by both `envBoolean` and `parseNameList` so the accepted set
 * is consistent.
 */
function parseBoolString(v: string): boolean | null {
  switch (v.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
    case "":
      return false;
    default:
      return null;
  }
}

/**
 * Strict boolean coercion for env vars.
 *
 * `z.coerce.boolean()` is a footgun — it delegates to JS `Boolean(x)` which
 * returns `true` for any non-empty string, so `"false"` becomes `true`.
 * Instead: accept the strings we mean to accept, and reject the rest.
 */
const envBoolean = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    const result = parseBoolString(v);
    if (result === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected boolean-like value (true/false/1/0/yes/no/on/off), got "${v}"`,
      });
      return z.NEVER;
    }
    return result;
  });

export const configSchema = z.object({
  /**
   * Database connection URL (required).
   *
   * Postgres: postgresql://localhost:5432/mydb
   * SQLite:   sqlite:./data.db  or  sqlite::memory:
   */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /** Optional read-replica URL. Falls back to DATABASE_URL. Ignored for SQLite. */
  DATABASE_READ_URL: z.string().optional(),

  /** Redis URL. Optional — PubSub + Queue fall back to in-process if absent. */
  REDIS_URL: z.string().optional(),

  /** HTTP port. Default: 3000 */
  PORT: z.coerce.number().default(3000),

  /** Auth secret for session signing. Required if auth is enabled. */
  AUTH_SECRET: z.string().optional(),

  /** Node environment. */
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /**
   * Whether to register CRUD routes, custom routes, and Socket.IO RPC.
   * When `false`, the HTTP server still binds to PORT and serves `/{version}/health`
   * (so Cloud Run / k8s probes work) but exposes nothing else.
   * Default: `true`.
   */
  RUN_SERVER: envBoolean,

  /**
   * Whether to register model lifecycle hooks (`hook.before` / `hook.after`).
   * When `false`, hooks are still discovered (so module side-effects fire),
   * but the adapter skips calling them on save/patch/remove.
   * Default: `true`.
   */
  RUN_HOOKS: envBoolean,

  /**
   * Whether to start BullMQ workers for background jobs.
   *
   *   - `"true"` (or `true`): subscribe to every registered job's per-name queue.
   *   - `"false"` (or unset): do not start any worker. Jobs can still be enqueued
   *     from this process; they sit in the queue until a worker process consumes them.
   *   - `"name1,name2,..."`: subscribe only to the listed job names. Useful for
   *     splitting workloads across worker fleets, or routing GPU-heavy jobs to a
   *     dedicated cluster.
   *
   * Default: `"false"`.
   */
  RUN_JOBS: z.string().optional(),

  /**
   * Whether to schedule in-process cron tasks registered via `cron()`.
   * Multi-instance safety is built in: each tick acquires a distributed
   * try-lock keyed on the cron name + fire timestamp so only one process
   * runs the handler per tick.
   *
   *   - `"true"` (or `true`): schedule every registered cron.
   *   - `"false"` (or unset): don't schedule any cron on this process.
   *   - `"name1,name2,..."`: schedule only the listed crons. Useful for
   *     pinning specific schedules to specific worker fleets (e.g. a
   *     "heavy nightly report" cron lives on a beefier instance).
   *
   * Default: follows `RUN_JOBS`. If `RUN_JOBS != false` the default is
   * `true` (run all crons), otherwise `false`.
   */
  RUN_CRONS: z.string().optional(),

  /** Trusted origins for CORS. Comma-separated. */
  TRUSTED_ORIGINS: z.string().optional(),

  /** Backend URL (for auth callbacks, etc). Default: http://localhost:{PORT} */
  BACKEND_URL: z.string().optional(),

  /** Frontend URL. */
  FRONTEND_URL: z.string().optional(),

  /** job queue name. Default: "parcae" */
  JOB_QUEUE_NAME: z.string().optional().default("parcae"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Resolved per-process runtime flags, derived from the raw env config.
 *
 *   - `server`: register CRUD / custom routes / Socket.IO RPC?
 *   - `hooks`: invoke model lifecycle hooks?
 *   - `jobs`: start BullMQ workers? `true` = handle all, `false` = none,
 *     `Set<string>` = handle only the named jobs.
 *   - `crons`: schedule in-process cron tasks? Same shape as `jobs`.
 *     Defaults to following `jobs` (any process running jobs also runs
 *     all crons; pure server processes don't).
 *
 * @see resolveRuntimeFlags
 */
export interface RuntimeFlags {
  server: boolean;
  hooks: boolean;
  jobs: true | false | ReadonlySet<string>;
  crons: true | false | ReadonlySet<string>;
}

/**
 * Parse a `RUN_JOBS` / `RUN_CRONS`-style env value into
 * `true | false | Set<name>`. Both flags share the syntax:
 *
 *   "true" / "1" / "yes" / "on"   → true
 *   "false" / "0" / "no" / "off"  → false
 *   "" / undefined                → false
 *   "name1,name2"                  → Set { "name1", "name2" }
 */
function parseNameList(value: string | undefined): true | false | Set<string> {
  if (value === undefined || value === "") return false;
  const result = parseBoolString(value.trim());
  if (result !== null) return result;
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return false;
  return new Set(names);
}

/**
 * Resolve the four runtime flags (`server`, `hooks`, `jobs`, `crons`)
 * from raw env config.
 */
export function resolveRuntimeFlags(config: Config): RuntimeFlags {
  const server = config.RUN_SERVER ?? true;
  const hooks = config.RUN_HOOKS ?? true;
  const jobs = parseNameList(config.RUN_JOBS);
  const crons =
    config.RUN_CRONS !== undefined
      ? parseNameList(config.RUN_CRONS)
      : jobs !== false;

  return { server, hooks, jobs, crons };
}

/**
 * Parse and validate configuration from process.env.
 * Throws with clear error messages on missing/invalid values.
 */
export function parseConfig(
  env: Record<string, string | undefined> = process.env,
  projectRoot?: string,
): Config {
  // Auto-load .env file
  loadEnvFile(projectRoot);

  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `[parcae] Invalid configuration:\n${errors}\n\n` +
        `Set missing values in .env or your environment.\n` +
        `See: https://parcae.dev/docs/config`,
    );
  }

  return result.data;
}

/**
 * Detect whether a DATABASE_URL points to SQLite.
 * Matches: sqlite:./path, sqlite::memory:, or bare .db/.sqlite file paths.
 */
export function isSqliteUrl(url: string): boolean {
  return (
    url.startsWith("sqlite:") ||
    url.endsWith(".db") ||
    url.endsWith(".sqlite") ||
    url.endsWith(".sqlite3") ||
    url === ":memory:"
  );
}

/**
 * Extract the SQLite filename from a DATABASE_URL.
 * sqlite:./data.db -> ./data.db
 * sqlite::memory:  -> :memory:
 * ./data.db        -> ./data.db
 */
export function sqliteFilename(url: string): string {
  if (url.startsWith("sqlite:")) return url.slice("sqlite:".length);
  return url;
}
