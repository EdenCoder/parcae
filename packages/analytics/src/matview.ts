/**
 * @parcae/analytics — Materialized view orchestration
 *
 * For aggregates too expensive to compute per-request (cohort
 * retention, behaviour-by-segment), define a matview once, and the
 * scheduler refreshes it `CONCURRENTLY` on a cadence. Reads are then a
 * single index lookup.
 *
 * `defineMatview()` registers the SQL — the runtime creates the
 * matview if missing and refreshes on demand. `refreshAll()` is meant
 * to be called from a BullMQ worker on a schedule (default every 15
 * min) and is also exposed manually so a `Refresh` button can flush
 * everything ahead of schedule.
 *
 * `CONCURRENTLY` requires a unique index — registration enforces this
 * by accepting a `uniqueColumns` list and creating the index at first
 * touch.
 */

import type { Knex } from "knex";

export interface MatviewSpec {
  /** Matview name (Postgres identifier). */
  name: string;
  /** SELECT body (without leading `CREATE MATERIALIZED VIEW <name> AS`). */
  sql: string;
  /** Columns that uniquely identify a row — required for CONCURRENTLY refresh. */
  uniqueColumns: string[];
}

const matviews = new Map<string, MatviewSpec>();

export function defineMatview(spec: MatviewSpec): void {
  if (matviews.has(spec.name)) {
    throw new Error(`Matview already defined: ${spec.name}`);
  }
  if (spec.uniqueColumns.length === 0) {
    throw new Error(
      `Matview ${spec.name}: uniqueColumns required for CONCURRENTLY refresh`,
    );
  }
  matviews.set(spec.name, spec);
}

export function listMatviews(): MatviewSpec[] {
  return Array.from(matviews.values());
}

export function clearMatviews(): void {
  matviews.clear();
}

export async function ensureMatview(db: Knex, spec: MatviewSpec): Promise<void> {
  const exists = await matviewExists(db, spec.name);
  if (!exists) {
    await db.raw(`CREATE MATERIALIZED VIEW "${spec.name}" AS ${spec.sql}`);
  }
  const indexName = `${spec.name}_unique_idx`;
  const cols = spec.uniqueColumns.map((c) => `"${c}"`).join(", ");
  await db.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${spec.name}" (${cols})`,
  );
}

export async function ensureAllMatviews(db: Knex): Promise<void> {
  for (const spec of matviews.values()) {
    await ensureMatview(db, spec);
  }
}

export async function refreshMatview(
  db: Knex,
  name: string,
  options: { concurrently?: boolean } = {},
): Promise<void> {
  const concurrently = options.concurrently ?? true;
  await db.raw(
    `REFRESH MATERIALIZED VIEW${concurrently ? " CONCURRENTLY" : ""} "${name}"`,
  );
}

/**
 * Refresh all registered matviews. Errors are caught per-matview so
 * one slow query doesn't poison the rest. Returns a per-matview
 * outcome the scheduler can log.
 */
export async function refreshAll(
  db: Knex,
  options: { concurrently?: boolean } = {},
): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  for (const spec of matviews.values()) {
    const startedAt = new Date();
    try {
      await refreshMatview(db, spec.name, options);
      out.push({
        name: spec.name,
        ok: true,
        startedAt,
        finishedAt: new Date(),
      });
    } catch (err) {
      out.push({
        name: spec.name,
        ok: false,
        startedAt,
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export interface RefreshOutcome {
  name: string;
  ok: boolean;
  startedAt: Date;
  finishedAt: Date;
  error?: string;
}

async function matviewExists(db: Knex, name: string): Promise<boolean> {
  const { rows } = (await db.raw(
    `SELECT 1 FROM pg_matviews WHERE matviewname = ?`,
    [name],
  )) as { rows: unknown[] };
  return rows.length > 0;
}
