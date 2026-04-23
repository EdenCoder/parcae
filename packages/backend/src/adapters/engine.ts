/**
 * @parcae/backend — engine detection
 *
 * Pure, dependency-free engine detection. Used by BackendAdapter and by the
 * CLI, which doesn't want the full adapter stack just to know whether it's
 * talking to SQLite, stock Postgres, or AlloyDB.
 */

import type { Knex } from "knex";

export type Engine = "alloydb" | "postgres" | "sqlite";

/**
 * Detect database engine from a raw Knex connection.
 *
 * Pass `hint="sqlite"` when you already know the client is better-sqlite3
 * (cheaper than probing — and `pg_available_extensions` would error anyway).
 *
 * Falls back to `"postgres"` on any probe failure: AlloyDB detection is a
 * best-effort optimisation, and getting it wrong just disables vector search
 * — never breaks core functionality.
 */
export async function detectEngine(
  db: Knex,
  hint?: "sqlite",
): Promise<Engine> {
  if (hint === "sqlite") return "sqlite";
  try {
    const { rows } = await db.raw(`
      SELECT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'alloydb_scann'
      ) AS has_scann
    `);
    return rows[0]?.has_scann ? "alloydb" : "postgres";
  } catch {
    return "postgres";
  }
}
