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

  /** Whether to run as a server (HTTP + WebSocket). */
  SERVER: z.coerce.boolean().default(true),

  /** Whether to run background daemons/workers. */
  DAEMON: z.coerce.boolean().default(false),

  /** Trusted origins for CORS. Comma-separated. */
  TRUSTED_ORIGINS: z.string().optional(),

  /** Backend URL (for auth callbacks, etc). Default: http://localhost:{PORT} */
  BACKEND_URL: z.string().optional(),

  /** Frontend URL. */
  FRONTEND_URL: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

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
