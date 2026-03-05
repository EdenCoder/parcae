/**
 * @parcae/backend — Configuration
 *
 * Zod-validated env vars with sensible defaults. Fail-fast on missing required config.
 */

import { z } from "zod";

export const configSchema = z.object({
  /** PostgreSQL connection URL (required). */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /** Optional read-replica URL. Falls back to DATABASE_URL. */
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
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate configuration from process.env.
 * Throws with clear error messages on missing/invalid values.
 */
export function parseConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
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
