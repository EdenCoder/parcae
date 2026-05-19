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
 * Strict boolean coercion for env vars.
 *
 * `z.coerce.boolean()` is a footgun — it delegates to JS `Boolean(x)` which
 * returns `true` for any non-empty string, so `"false"` becomes `true`.
 * That's exactly how the original `SERVER` / `DAEMON` flags ended up silently
 * non-functional.
 *
 * Instead: accept the strings we mean to accept, and reject the rest. Anything
 * outside `{true,false,1,0,yes,no,on,off}` (case-insensitive) is a config
 * error worth surfacing to the operator.
 */
const envBoolean = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
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
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected boolean-like value (true/false/1/0/yes/no/on/off), got "${v}"`,
        });
        return z.NEVER;
    }
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
   *   - `"true"` (or `true`): start a single worker that handles all registered job names.
   *   - `"false"` (or unset): do not start any worker. Jobs can still be enqueued
   *     from this process; they sit in the queue until a worker process consumes them.
   *   - `"name1,name2,..."`: reserved syntax for per-name worker routing. Parsed but
   *     not yet implemented — currently behaves the same as `"true"` with a warning.
   *
   * Default: `"false"`.
   */
  RUN_JOBS: z.string().optional(),

  /**
   * @deprecated Use `RUN_SERVER` instead. Kept for backward compatibility.
   * If both are set, `RUN_SERVER` wins.
   */
  SERVER: envBoolean,

  /**
   * @deprecated Use `RUN_HOOKS` and `RUN_JOBS` instead. Kept for backward compatibility.
   * `DAEMON=true` is equivalent to `RUN_HOOKS=true RUN_JOBS=true`.
   * If RUN_HOOKS / RUN_JOBS are explicitly set, they win over DAEMON.
   */
  DAEMON: envBoolean,

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
 *     `Set<string>` = handle only the named jobs (reserved; today behaves as `true`).
 *
 * @see resolveRuntimeFlags
 */
export interface RuntimeFlags {
  server: boolean;
  hooks: boolean;
  jobs: true | false | ReadonlySet<string>;
}

/**
 * Parse the `RUN_JOBS` env value into `true | false | Set<name>`.
 * Comma-list is reserved for future per-name routing; today the worker
 * still accepts all job names and logs a warning.
 */
function parseRunJobs(value: string | undefined): true | false | Set<string> {
  if (value === undefined || value === "") return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "0") return false;
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return false;
  return new Set(names);
}

/**
 * Resolve the three runtime flags (`server`, `hooks`, `jobs`) from raw env config.
 *
 * Honours legacy `SERVER` / `DAEMON` env vars with `RUN_*` taking precedence.
 * Emits one deprecation warning per legacy variable seen (caller supplies the
 * `warn` callback so this stays pure and unit-testable).
 *
 * @param config - Parsed env config from `parseConfig()`
 * @param warn - Sink for deprecation messages (e.g. `log.warn`)
 */
export function resolveRuntimeFlags(
  config: Config,
  warn: (msg: string) => void = () => {},
): RuntimeFlags {
  // ── server ─────────────────────────────────────────────────────────
  let server: boolean;
  if (config.RUN_SERVER !== undefined) {
    server = config.RUN_SERVER;
  } else if (config.SERVER !== undefined) {
    warn(
      "[config] SERVER is deprecated — use RUN_SERVER. See @parcae/backend env docs.",
    );
    server = config.SERVER;
  } else {
    server = true;
  }

  // ── hooks ──────────────────────────────────────────────────────────
  // Hooks default to ON whenever the operator hasn't explicitly opted out.
  // Legacy DAEMON=true historically enabled both hooks and jobs; legacy
  // DAEMON=false meant "server only" but hooks still ran because the
  // adapter never consulted the flag. We preserve both shapes: hooks
  // remain on unless RUN_HOOKS=false is explicitly set.
  let hooks: boolean;
  if (config.RUN_HOOKS !== undefined) {
    hooks = config.RUN_HOOKS;
  } else if (config.DAEMON !== undefined) {
    warn(
      "[config] DAEMON is deprecated — set RUN_HOOKS and RUN_JOBS explicitly. " +
        "DAEMON does not control hook execution; hooks default to enabled.",
    );
    hooks = true;
  } else {
    hooks = true;
  }

  // ── jobs ───────────────────────────────────────────────────────────
  let jobs: true | false | ReadonlySet<string>;
  if (config.RUN_JOBS !== undefined) {
    jobs = parseRunJobs(config.RUN_JOBS);
  } else if (config.DAEMON !== undefined) {
    // We may have already warned above; don't warn twice. DAEMON=true → jobs on.
    jobs = config.DAEMON;
  } else {
    jobs = false;
  }

  return { server, hooks, jobs };
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
