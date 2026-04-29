/**
 * @parcae/analytics — Metric base class
 *
 * A `Metric` is a definition that lives in TypeScript (not a DB row)
 * and produces snapshot fills. Subclasses implement `compute()`,
 * returning one or more `MetricSnapshot` records to upsert.
 *
 * ```ts
 * class WauMetric extends Metric {
 *   key = "engagement.wau";
 *   grain = "week" as const;
 *   version = 1;
 *
 *   async compute({ org, period, db }: MetricContext): Promise<MetricSnapshot[]> {
 *     const { rows } = await db.raw(`
 *       SELECT count(distinct subject)::int AS v
 *         FROM analytics_event
 *        WHERE org = ? AND "occurredAt" >= ?
 *     `, [org, period.start]);
 *     return [{ value: rows[0].v }];
 *   }
 * }
 * ```
 *
 * `runMetric()` resolves the metric over a period, calls `compute()`,
 * and persists each result with the canonical
 * `(org, metricKey, grain, periodStart, dimensions)` upsert key. The
 * registry is in-memory — no DB row for the definition itself.
 */

import type { Knex } from "knex";
import { Period, type Grain } from "./period.js";
import {
  ANALYTICS_SNAPSHOT_TABLE,
  canonicalDimensions,
} from "./schema.js";
import { generateId } from "./id.js";

export interface MetricContext {
  org: string;
  period: Period;
  db: Knex;
  now: Date;
}

export interface MetricSnapshot {
  /** The numeric value being recorded. */
  value: number;
  /**
   * Optional dimension key — used for breakdowns ("by-condition",
   * "by-clinician"). Defaults to `{}` for the headline number.
   */
  dimensions?: Record<string, unknown>;
  /**
   * Metadata pushed onto the row. Intended for things consumers want
   * to read alongside the value but don't need indexed: per-cohort
   * patient ids for drill-down, mean alongside median, etc. Capped at
   * 64KB to stop unbounded blob growth.
   */
  metadata?: Record<string, unknown>;
}

const MAX_METADATA_BYTES = 64 * 1024;

export abstract class Metric {
  /** Hierarchical key, e.g. `"engagement.wau"`. */
  abstract readonly key: string;
  /**
   * Display name for surfacing in the dashboard. Optional — most
   * surfaces read the contract, not the metric class directly.
   */
  readonly name?: string;
  /** Semantic grain. Defaults to `"week"` since most clinical metrics are weekly. */
  readonly grain: Grain = "week";
  /** Bumping this invalidates older rows during read fan-out. */
  readonly version: number = 1;

  abstract compute(ctx: MetricContext): Promise<MetricSnapshot[]>;
}

const registry = new Map<string, Metric>();

export function registerMetric(metric: Metric): void {
  if (registry.has(metric.key)) {
    throw new Error(`Metric key collision: ${metric.key}`);
  }
  registry.set(metric.key, metric);
}

export function getMetric(key: string): Metric | undefined {
  return registry.get(key);
}

export function listMetrics(): Metric[] {
  return Array.from(registry.values());
}

export function clearMetrics(): void {
  registry.clear();
}

/**
 * Run a single metric for an org over a period. Persists each snapshot
 * via canonical upsert. Returns the rows that were written so callers
 * can post-process (e.g. cache, return to caller of /metrics/run).
 */
export async function runMetric(
  metric: Metric,
  ctx: MetricContext,
): Promise<PersistedSnapshot[]> {
  const snapshots = await metric.compute(ctx);
  return persistSnapshots(metric, ctx, snapshots);
}

export async function runMetrics(
  metrics: Metric[],
  ctx: MetricContext,
): Promise<PersistedSnapshot[]> {
  // Snapshot writes are scoped to (org, metricKey) so per-metric runs
  // are independent — parallel-safe. One slow metric no longer
  // blocks the whole batch.
  const persisted = await Promise.all(metrics.map((m) => runMetric(m, ctx)));
  return persisted.flat();
}

export interface PersistedSnapshot {
  org: string;
  metricKey: string;
  grain: Grain;
  periodStart: Date;
  periodEnd: Date;
  value: number;
  dimensions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  metricVersion: number;
  computedAt: Date;
}

async function persistSnapshots(
  metric: Metric,
  ctx: MetricContext,
  snapshots: MetricSnapshot[],
): Promise<PersistedSnapshot[]> {
  if (snapshots.length === 0) return [];

  const rows = snapshots.map((s) => {
    const metadata = s.metadata ?? {};
    if (byteLength(metadata) > MAX_METADATA_BYTES) {
      throw new Error(
        `analytics_snapshot metadata exceeded ${MAX_METADATA_BYTES} bytes for key=${metric.key}`,
      );
    }
    const dimensions = s.dimensions ?? {};
    return {
      id: generateId(),
      org: ctx.org,
      metricKey: metric.key,
      grain: metric.grain,
      periodStart: ctx.period.start,
      periodEnd: ctx.period.end,
      value: s.value,
      dimensions: canonicalDimensions(dimensions),
      metadata,
      metricVersion: metric.version,
      computedAt: ctx.now,
    };
  });

  // Upsert via the canonical unique key. On conflict, refresh value +
  // metadata + version + computedAt so subsequent reads always see the
  // freshest row for that bucket.
  await ctx.db(ANALYTICS_SNAPSHOT_TABLE)
    .insert(rows)
    .onConflict(["org", "metricKey", "grain", "periodStart", "dimensions"])
    .merge(["value", "metadata", "metricVersion", "computedAt", "periodEnd"]);

  return rows.map((r) => ({
    ...r,
    dimensions: JSON.parse(r.dimensions) as Record<string, unknown>,
  }));
}

function byteLength(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj ?? {}), "utf8");
}

/**
 * Read the latest snapshot for `(org, key, grain)`. Used by contracts
 * + cross-metric reads. Returns `null` when no snapshot exists.
 */
export async function readLatestSnapshot(
  db: Knex,
  org: string,
  key: string,
  grain: Grain,
  dimensions: Record<string, unknown> = {},
): Promise<PersistedSnapshot | null> {
  const row = await db(ANALYTICS_SNAPSHOT_TABLE)
    .where({
      org,
      metricKey: key,
      grain,
      dimensions: canonicalDimensions(dimensions),
    })
    .orderBy("periodStart", "desc")
    .first();
  if (!row) return null;
  return {
    ...row,
    dimensions:
      typeof row.dimensions === "string"
        ? JSON.parse(row.dimensions)
        : row.dimensions,
    metadata:
      typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  } as PersistedSnapshot;
}

/**
 * Read snapshot series for `(org, key, grain)` over a period. Used by
 * trend charts. Ordered by `periodStart` ascending.
 */
export async function readSnapshotSeries(
  db: Knex,
  org: string,
  key: string,
  grain: Grain,
  period: Period,
  dimensions: Record<string, unknown> = {},
): Promise<PersistedSnapshot[]> {
  const rows = await db(ANALYTICS_SNAPSHOT_TABLE)
    .where({
      org,
      metricKey: key,
      grain,
      dimensions: canonicalDimensions(dimensions),
    })
    .where("periodStart", ">=", period.start)
    .where("periodStart", "<", period.end)
    .orderBy("periodStart", "asc");
  return rows.map((row: Record<string, unknown>) => ({
    ...row,
    dimensions:
      typeof row.dimensions === "string"
        ? JSON.parse(row.dimensions)
        : row.dimensions,
    metadata:
      typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  })) as PersistedSnapshot[];
}
